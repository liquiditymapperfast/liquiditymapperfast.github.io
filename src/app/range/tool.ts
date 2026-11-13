import type { Store } from '../store.ts';
import { venueLabel } from '../venues.ts';
import type { Hub } from '../hub.ts';
import { el } from '../dom.ts';
import { openPanel, openedPanel, type Panel } from '../ui.ts';
import { helpButton } from '../help.ts';
import { compactBar } from '../device.ts';
import { activeIds, kindOf } from '../scope.ts';
import { flowIds } from '../cvd/ids.ts';
import { gridStepFor } from '../../shared/grid.ts';
import { t } from '../i18n.ts';
import { MINUTE, draftOf, follow, inReplay, refreshMs, rowStep, snap, type RangePane, type RangeSelection } from './selection.ts';
import type { RangeProvider } from './provider.ts';
import { priceOf, pricePieces, rangeLines, type RangeInput, type RangeLine } from './stats.ts';
import { venueMark } from '../venue-marks.ts';
import { scaledUsd } from '../coin.ts';
import { pageNow, replaying } from '../replay/clock.ts';

/**
 * The panel's lines, kept as elements: a line is built again only when what it says changes, and the list is put in order only when the
 * order changes, so a live selection's figures can be taken again every few seconds without rebuilding the panel (or losing its scroll).
 */
export class LineList {
  readonly root = el('div', { class: 'range-lines' });
  readonly #nodes = new Map<string, { node: HTMLElement; sig: string }>();

  update(lines: readonly RangeLine[]): void {
    const next: HTMLElement[] = [], keep = new Set<string>();
    for (const line of lines) {
      const sig = JSON.stringify([line.kind, line.cells, line.share, line.bars, line.tone, line.mark, line.profile, line.stack, line.parts, line.signed, line.grid]);
      let held = this.#nodes.get(line.key);
      if (!held || held.sig !== sig) { held = { node: lineNode(line), sig }; this.#nodes.set(line.key, held); }
      keep.add(line.key); next.push(held.node);
    }
    for (const key of [...this.#nodes.keys()]) if (!keep.has(key)) this.#nodes.delete(key);
    const now = this.root.children;
    if (now.length !== next.length || next.some((node, i) => now[i] !== node)) this.root.replaceChildren(...next);
  }
}

function lineNode(line: RangeLine): HTMLElement {
  const tone = line.tone ? ` ${line.tone}` : '';
  switch (line.kind) {
    case 'title': return el('div', { class: 'range-title', textContent: line.cells[0] ?? '' });
    case 'heading': return el('h4', { textContent: line.cells[0] ?? '' });
    case 'note': return el('p', { class: `panel-note range-note${tone}`, textContent: line.cells[0] ?? '' });
    case 'stat': return el('div', { class: `range-stat${tone}${line.stack ? ' stack' : ''}` }, el('span', { class: 'label', textContent: line.cells[0] ?? '' }), el('span', { class: 'value', textContent: line.cells[1] ?? '' }));
    case 'split': {
      const bar = el('div', { class: 'range-split-bar' }, el('i', { class: 'buy' }), el('i', { class: 'sell' }));
      bar.style.setProperty('--share', `${((line.share ?? 0.5) * 100).toFixed(1)}%`);
      return el('div', { class: 'range-split' }, bar, el('div', { class: 'range-split-labels' }, el('span', { class: 'buy', textContent: line.cells[0] ?? '' }), el('span', { class: 'sell', textContent: line.cells[1] ?? '' })));
    }
    case 'row': {
      const row = el('div', { class: `range-row${tone}` }, ...line.cells.map((text, i) => i === 0 && line.mark ? el('span', {}, venueMark(line.mark, 13), text) : el('span', { textContent: text })));
      if (line.bars) {
        const [buy, sell] = line.bars, cells = row.children;
        (cells[1] as HTMLElement).classList.add('bar', 'buy'); (cells[1] as HTMLElement).style.setProperty('--w', `${(buy * 100).toFixed(1)}%`);
        (cells[2] as HTMLElement).classList.add('bar', 'sell'); (cells[2] as HTMLElement).style.setProperty('--w', `${(sell * 100).toFixed(1)}%`);
      }
      return row;
    }
    case 'stack': {
      // A label, the parts end to end on the section's scale, the total; each part says itself in its tip.
      const bar = el('span', { class: 'bars' });
      for (const part of line.parts ?? []) {
        if (!(part.size > 0)) continue;
        const piece = el('i', { class: `${part.tone}${part.closed ? ' closed' : ''}`, tip: part.tip });
        piece.style.setProperty('--w', `${(Math.max(0, part.size) * 100).toFixed(2)}%`);
        bar.append(piece);
      }
      return el('div', { class: `range-stack${tone}` }, el('span', { class: 'label', textContent: line.cells[0] ?? '' }), bar, el('span', { class: 'total', textContent: line.cells[1] ?? '' }));
    }
    case 'signed': {
      // Out of the zero line in the middle: right for more, left for less, as long as its share of the longest.
      const v = Math.max(-1, Math.min(1, line.signed ?? 0)), bar = el('span', { class: 'bars' }, el('i', { class: v >= 0 ? 'up' : 'down' }));
      bar.style.setProperty('--v', `${(Math.abs(v) * 50).toFixed(2)}%`);
      const label = line.mark ? el('span', { class: 'label' }, venueMark(line.mark, 13), line.cells[0] ?? '') : el('span', { class: 'label', textContent: line.cells[0] ?? '' });
      const total = el('span', { class: 'total', textContent: line.cells[1] ?? '' });
      if (line.cells[2]) total.append(el('small', { textContent: line.cells[2] }));
      return el('div', { class: `range-signed${tone}${v < 0 ? ' less' : ''}` }, label, bar, total);
    }
    case 'grid': {
      // Tiles two to a row: a label, the figure (or lines of counts) and a note; the tip says what the statistic is.
      const grid = el('div', { class: 'range-grid' });
      for (const item of line.grid ?? []) {
        const tile = el('div', { class: `range-tile${item.tone && item.tone !== 'text' ? ` ${item.tone}` : ''}`, ...(item.tip ? { tip: item.tip } : {}) }, el('span', { class: 'label', textContent: item.label }));
        if (item.value) tile.append(el('span', { class: 'value', textContent: item.value }));
        for (const row of item.rows ?? []) tile.append(el('span', { class: `count${row.tone && row.tone !== 'text' ? ` ${row.tone}` : ''}` }, el('span', { textContent: row.label }), el('b', { textContent: row.value })));
        if (item.note) tile.append(el('small', { textContent: item.note }));
        grid.append(tile);
      }
      return grid;
    }
    case 'profile': {
      const box = el('div', { class: 'range-profile' });
      for (const bar of line.profile ?? []) {
        const bars = el('span', { class: 'bars' }, el('i', { class: 'buy' }), el('i', { class: 'sell' }));
        bars.style.setProperty('--b', `${(bar.buy * 100).toFixed(1)}%`); bars.style.setProperty('--s', `${(bar.sell * 100).toFixed(1)}%`);
        box.append(el('div', { class: `range-prof-row${bar.top ? ' top' : ''}` }, el('span', { class: 'price', textContent: bar.label }), bars, el('span', { class: 'total', textContent: bar.total })));
      }
      return box;
    }
  }
}

/** A point of a drag: a time, and on the map a price. */
export interface RangePoint { t: number; p: number | null }

/**
 * The Range tool: the toolbar button arms it, a drag on the map selects a box and a drag on a pane under it (or across the flow column)
 * selects a stretch of time, and Ctrl+drag (Cmd on a Mac) selects at any time. The panel then says what happened there (`stats.ts`). The
 * panes call `begin`, `move` and `end`; what they draw comes from `store.state.range`.
 *
 * Everything is gathered for one selection at once, for one set of instruments (the exchanges switched on inside the Spot / Perp filter):
 * the recording's answer, the resting orders in a box, the absorption marks and the largest orders the map holds there. A live selection
 * (one that reaches the open minute) is gathered again while the panel is open and the page is shown, at an interval that grows with how
 * long the last answer took.
 */
export class RangeTool {
  #panel: Panel | null = null;
  readonly #lines = new LineList();
  #start: RangePoint | null = null;
  /** The selection a drag replaces, put back when the drag comes to nothing. */
  #before: RangeSelection | null = null;
  #input: RangeInput | null = null;
  #asked = 0;
  /** The selection the open interest belongs to (a new one, or closing, moves it on), whether a request for it is out, and what it answered for. */
  #oiFor = 0;
  #oiBusy = -1;
  /** The same for the price line: the selection it belongs to, and the one a question is out for. */
  #priceFor = 0;
  #priceBusy = -1;
  #oiKey = '';
  #lastMs = 0;
  #timer = 0;
  #stopping = false;
  /** The panes that sum up a stretch in their own terms (provider.ts), and which summary the panel shows: the map's, or a pane's. */
  readonly #providers = new Map<RangePane, RangeProvider>();
  #context: 'map' | RangePane = 'map';
  readonly #show = el('select', { class: 'range-show' });
  /** A pane's summary drawn again at most once a second as its data changes, and each second while it is live (its end follows the clock). */
  #paneTimer = 0;
  #paneDrawn = 0;
  /** The toolbar's button: the panel opens beside it. */
  anchor: HTMLElement | null = null;
  /** The map's time window (set by the page): the absorption marks and the large orders are loaded for it, and for no other. */
  mapWindow: () => { t0: number; t1: number } | null = () => null;

  constructor(private store: Store, private hub: Hub) {
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && this.#start) { e.preventDefault(); this.cancel(); } });
    document.addEventListener('visibilitychange', () => { this.#schedule(); this.#paneSoon(); });
    this.#show.onchange = () => this.#choose(this.#show.value === 'map' ? 'map' : this.#show.value as RangePane);
  }

  /** A pane that sums up a stretch in its own terms: a drag in it opens its summary, and the Show menu offers it. */
  useProvider(provider: RangeProvider): void { this.#providers.set(provider.pane, provider); }

  /** The pane's data changed (it drew new bars): its summary is drawn again soon, if it is the one shown. */
  paneChanged(pane: RangePane): void { if (this.#context === pane && this.#panel) this.#paneSoon(); }
  #paneLater = 0;
  /**
   * What a pane stands for may have changed before it drew again (its scripts edited, the timeframe changed): its summary is drawn again
   * after its next drawing, two frames on (once however often it is asked meanwhile).
   */
  paneLater(): void {
    if (this.#paneLater || this.#context === 'map') return;
    this.#paneLater = requestAnimationFrame(() => { this.#paneLater = requestAnimationFrame(() => { this.#paneLater = 0; this.#paneSoon(); }); });
  }

  /** Show the map's summary or a pane's, for the selection as it is: the map's is gathered when it is first shown for this selection. */
  #choose(context: 'map' | RangePane): void {
    if (context !== 'map' && !this.#providers.has(context)) context = 'map';
    if (context === this.#context) return;
    this.#context = context;
    const sel = this.store.state.range;
    if (!sel || sel.draft) { this.#render(); return; }
    // Back on the map's summary of the same selection: what the map holds is read again (it was left alone meanwhile), and a live one goes on.
    if (context === 'map') { if (this.#input?.sel !== sel) void this.#gather(sel, true); else { this.#input = { ...this.#input, ...this.#held(sel), oiPane: this.#providers.get('oi')?.shown() ?? false }; this.#render(); this.#schedule(); } }
    else { window.clearTimeout(this.#timer); this.#timer = 0; this.#render(); this.#paneSoon(); }
  }

  /**
   * Draw the pane's summary again: at once when the last drawing was a second ago or more, else when that second is up; and while the
   * selection is live, again every second (its end moves on with the clock). Nothing while the panel is closed or the page is hidden.
   */
  #paneSoon(): void {
    if (this.#paneTimer || this.#context === 'map' || !this.#panel || document.hidden) return;
    const wait = Math.max(0, 1000 - (performance.now() - this.#paneDrawn));
    this.#paneTimer = window.setTimeout(() => {
      this.#paneTimer = 0;
      const sel = this.store.state.range;
      if (!sel || sel.draft || !this.#panel || this.#context === 'map') return;
      const moved = replaying() ? sel : follow(sel, pageNow());
      if (moved !== sel) this.store.set({ range: moved });
      this.#paneDrawn = performance.now(); this.#render();
      if (moved.live) this.#paneSoon();
    }, wait);
  }

  get armed(): boolean { return this.store.state.rangeTool; }
  get dragging(): boolean { return this.#start !== null; }

  /**
   * The toolbar button: with the panel open it puts everything away; a selection whose panel another panel replaced gets its panel back
   * (figures taken again); armed without a panel (a phone) it disarms; otherwise it arms.
   */
  toggle(): void {
    const sel = this.store.state.range;
    if (this.#panel) this.stop();
    else if (sel && !sel.draft) { this.#open(); if (this.#context === 'map') void this.#gather(sel, false); else { this.#render(); this.#paneSoon(); } }
    else if (this.store.state.rangeTool) this.stop();
    else this.arm();
  }

  /** Arm the tool: the next drag selects. On a desktop the panel says how; on a phone it would cover the map, so it waits for the selection. */
  arm(): void {
    this.store.set({ rangeTool: true });
    if (!compactBar()) this.#open();
    if (!this.store.state.range) this.#render();
  }

  stop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    window.clearTimeout(this.#timer); this.#timer = 0; window.clearTimeout(this.#paneTimer); this.#paneTimer = 0; this.#asked++; this.#oiFor++; this.#priceFor++;
    this.#start = null; this.#before = null; this.#input = null; this.#context = 'map';
    this.store.set({ rangeTool: false, range: null });
    this.#panel?.close(); this.#panel = null;
    this.#stopping = false;
  }

  /** A drag begins at `at`, in the pane under the map `pane` (none: the map or the flow column). */
  begin(at: RangePoint, pane?: RangePane): void {
    this.#start = at; this.#pane = pane; this.#before = this.store.state.range?.draft === false ? this.store.state.range : null;
    this.store.set({ range: draftOf(at, at, pane, this.#step()) });
  }
  /** The pane the drag in progress began in. */
  #pane: RangePane | undefined;
  /** The bars a drag in progress holds whole: those of the pane it began in, where that pane sums up its own; else none (minutes, at the end). */
  #step(): number | undefined { const provider = this.#pane ? this.#providers.get(this.#pane) : undefined, ms = provider?.barMs() ?? 0; return ms > 0 ? ms : undefined; }
  /** The drag is at `at`; `from` moves where it began too (a drag on the traded column holds whole rows, so both ends snap). */
  move(at: RangePoint, from?: RangePoint): void { if (!this.#start) return; if (from) this.#start = from; this.store.set({ range: draftOf(this.#start, at, this.#pane, this.#step()) }); }
  /** The drag ended at `at` (and began at `from`, when given). `small`: it covered too few pixels to be a selection (a click), and what was selected before stays. */
  end(at: RangePoint, small: boolean, from?: RangePoint): void {
    if (from && this.#start) this.#start = from;
    const start = this.#start; if (!start) return;
    if (small) { this.cancel(); return; }
    this.#start = null; this.#before = null;
    // A drag in a pane that sums up its own bars holds whole bars of it and opens its summary; elsewhere whole minutes and the map's.
    const provider = this.#pane ? this.#providers.get(this.#pane) : undefined, step = this.#step() ?? MINUTE;
    // Replay: snapped on its clock, up to its moment, and never live (the live refresh would move it with the real now).
    const snapped = snap(draftOf(start, at, this.#pane), pageNow(), step), sel = replaying() ? inReplay(snapped, pageNow(), provider !== undefined) : snapped;
    this.store.set({ range: sel, rangeTool: false });
    this.#context = provider ? provider.pane : 'map';
    this.#input = null; this.#asked++; window.clearTimeout(this.#timer); this.#timer = 0;
    this.#open();
    if (this.#context === 'map') void this.#gather(sel, true);
    else { this.#render(); this.#paneSoon(); }
  }
  cancel(): void {
    if (!this.#start) return;
    this.#start = null;
    this.store.set({ range: this.#before }); this.#before = null;
    // The selection put back goes on as it was: live, its figures are taken (or drawn) again; a refresh already due is left as it is.
    if (!this.#timer) this.#schedule();
    this.#paneSoon();
  }

  #open(): void {
    if (this.#panel || !this.anchor) return;
    const again = el('button', { type: 'button', textContent: t('New selection'), tip: t('Select another part of the map or of a pane: drag across it.'), onclick: () => { this.store.set({ rangeTool: true }); this.#render(); } });
    const show = el('label', { class: 'ctl range-show-ctl', tip: t('What the panel sums up for the selection: the map (market orders, absorption, resting orders), or a pane under it in its own terms. A drag in a pane opens its own.') }, t('Show'), this.#show);
    this.#panel = openPanel(this.anchor, { title: t('Range'), width: 420, align: 'left', stays: true, onClose: () => { this.#panel = null; window.clearTimeout(this.#timer); this.#timer = 0; window.clearTimeout(this.#paneTimer); this.#paneTimer = 0; queueMicrotask(() => { if (!openedPanel()) this.stop(); }); } }, (tools, body) => {
      tools.append(again, el('span', { class: 'spacer' }), show, helpButton('range'));
      body.append(this.#lines.root);
    });
  }

  /**
   * What the map holds inside `sel` (the absorption marks, the large orders and the liquidations), read from the hub as it is now. The marks
   * and the large orders are loaded for the map's window: a selection reaching outside it (across the flow column on a longer span) has them
   * only for its part on the map.
   */
  #held(sel: RangeSelection): Pick<RangeInput, 'marks' | 'marksCut' | 'prints' | 'liquidations' | 'liquidationMin' | 'kind' | 'partial' | 'books'> {
    const state = this.store.state, ids = flowIds(state, this.hub.flow.ids), idSet = new Set(ids);
    const band = sel.p0 !== null && sel.p1 !== null ? { p0: sel.p0, p1: sel.p1 } : null;
    const inside = (time: number, price: number): boolean => time >= sel.t0 && time < sel.t1 && (!band || (price >= band.p0 && price < band.p1));
    const s = state.absorption, now = Date.now(), thresholds = s.on ? this.hub.absorption.thresholds(ids, s, now) : null;
    const marks = thresholds ? this.hub.absorption.marks(ids, thresholds, sel.t0, sel.t1, band?.p0 ?? 0, band?.p1 ?? Infinity).filter(m => inside(m.t0, m.price)) : null;
    // Instruments whose marks may be missing at their thresholds (an answer cut at its limit, or more than the page holds), as the map says.
    const marksCut = thresholds ? ids.filter(id => { const most = this.hub.absorptionCut.get(id), threshold = thresholds.get(id); return most !== undefined && threshold !== null && threshold !== undefined && most >= threshold; }) : [];
    const prints = state.show.bubbles ? this.hub.prints.items.filter(p => idSet.has(p.id) && inside(p.t, p.price)) : null;
    const liquidations = state.liquidations.on ? this.hub.liquidations.items.filter(l => idSet.has(l.id) && inside(l.t, l.price)) : null;
    const kind = (id: string) => kindOf(state.markets, id);
    const map = this.mapWindow(), partial = map !== null && (sel.t0 < map.t0 || (!sel.live && sel.t1 > map.t1));
    // The order books on the map, and which are counted: what the coverage lines name.
    const on = new Set(activeIds(state)), books = state.levels ? state.levels.books.map(b => ({ id: b.id, on: on.has(b.id) })) : undefined;
    return { marks, marksCut, prints, liquidations, liquidationMin: scaledUsd(state.liquidations.minUsd), kind, partial, ...(books ? { books } : {}) };
  }

  /**
   * Read again what the map holds for the selection on show (its absorption groups, large orders or liquidations arrived after it was made,
   * or their settings changed), without asking the recording again; at most once a frame.
   */
  refreshHeld(): void {
    // A pane's summary reads its own snapshot (and the liquidations and panes shown): it is drawn again, not gathered, after the pane's next
    // drawing (two frames on). A pane on screen publishes its new snapshot first, so a change of what it stands for (another timeframe, say)
    // is never read against its old one (a second of "show it" on a pane in view); a hidden pane draws nothing, and its old snapshot is said
    // to be stale.
    if (this.#context !== 'map') { this.paneLater(); return; }
    if (this.#heldFrame || !this.#panel || !this.#input) return;
    this.#heldFrame = requestAnimationFrame(() => {
      this.#heldFrame = 0;
      const sel = this.store.state.range, input = this.#input;
      if (!sel || sel.draft || !input || !this.#panel || input.sel !== sel) return;
      this.#input = { ...input, ...this.#held(sel), oiPane: this.#providers.get('oi')?.shown() ?? false };
      this.#render();
    });
  }
  #heldFrame = 0;

  /** Gather everything for `sel` and show it; `fresh` when it is a new selection rather than a live one taken again. */
  async #gather(sel: RangeSelection, fresh: boolean): Promise<void> {
    const asked = ++this.#asked;
    if (fresh) { this.#oiFor++; this.#oiKey = ''; this.#priceFor++; }
    window.clearTimeout(this.#timer); this.#timer = 0;
    const state = this.store.state, ids = flowIds(state, this.hub.flow.ids);
    const band = sel.p0 !== null && sel.p1 !== null ? { p0: sel.p0, p1: sel.p1 } : null;
    const kept = !fresh && this.#input ? this.#input : null;
    this.#input = { sel, answer: kept?.answer ?? null, error: null, resting: kept?.resting ?? null, oi: kept && kept.oi !== undefined ? kept.oi : 'asking', price: kept && kept.price !== undefined ? kept.price : 'asking', oiPane: this.#providers.get('oi')?.shown() ?? false, ...this.#held(sel) };
    this.#render();
    // The chart market's price across the selection, from its finest candles that fit in one question; it fills in when it comes.
    const priceInst = state.seriesInstrument || state.marketId;
    if (!priceInst) this.#input = { ...this.#input, price: null };
    else if (this.#priceBusy !== this.#priceFor) {
      // One question at a time per selection: a live selection asked again every two seconds must not drop each answer for the next.
      const pieces = pricePieces(sel.t0, sel.t1), priceFor = this.#priceFor, market = `${venueLabel(priceInst)} ${priceInst.split(':').slice(1).join(':')}`;
      if (!pieces) this.#input = { ...this.#input, price: null };
      else {
        this.#priceBusy = priceFor;
        void Promise.all(pieces.map(piece => this.hub.source.candles(priceInst, piece.tf, piece.from, piece.to))).then(answers => priceOf(pieces, answers, market, replaying() ? pageNow() : Infinity), () => null).then(price => {
          if (this.#priceBusy === priceFor) this.#priceBusy = -1;
          if (priceFor !== this.#priceFor || !this.#input) return;
          this.#input = { ...this.#input, price }; this.#render();
        });
      }
    }
    const started = performance.now(), mark = state.mark.price > 0 ? state.mark.price : band ? (band.p0 + band.p1) / 2 : 0;
    const step = rowStep(sel, gridStepFor(mark > 0 ? mark : 1));
    const answer = this.hub.source.range(ids, sel.t0, sel.t1, band, step).then(a => ({ a, e: null }), (e: unknown) => ({ a: null, e: e instanceof Error ? e.message : String(e) }));
    const resting = band ? this.hub.cell(activeIds(state), sel.t0, sel.t1, band.p0, band.p1) : Promise.resolve(null);
    // The open interest of the market the OI pane shows, a sample a minute, from a little before the selection; where it adds several, the
    // largest of them (never the chart market, which may be one it does not count), and the lines say so.
    const parts = state.oiParts, largest = parts.length > 1 ? parts.reduce((a, b) => (b.bars[b.bars.length - 1]?.[4] ?? 0) > (a.bars[a.bars.length - 1]?.[4] ?? 0) ? b : a) : null;
    const oiInst = largest ? largest.id : state.oiInstrument || (state.oiMarkets === 'chart' ? state.seriesInstrument || state.marketId : ''), market = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId);
    // Its dollar figure at the price of the selection's end (the chart's candle there), not today's; it fills in when it comes, the rest does not wait.
    const endCandle = [...state.candles].reverse().find(c => c[0] < sel.t1), price = endCandle ? endCandle[4] : state.mark.price;
    const oiKey = `${oiInst}|${parts.length}|${Math.floor(sel.t0 / 60_000)}|${Math.floor(sel.t1 / 60_000)}`, oiFor = this.#oiFor, of = parts.length;
    if (!oiInst) this.#input = { ...this.#input, oi: null };
    else if (oiKey !== this.#oiKey && this.#oiBusy !== oiFor) {
      this.#oiBusy = oiFor;
      void this.hub.oiBars(oiInst, '1m', sel.t0 - 11 * 60_000, sel.t1 + 60_000, price > 0 ? price : undefined).then(bars => bars.length ? { inst: oiInst, bars, coin: market?.base ?? '', price, ...(of > 1 ? { of } : {}) } : null, () => null)
        .then(interest => {
          if (this.#oiBusy === oiFor) this.#oiBusy = -1;
          if (oiFor !== this.#oiFor || !this.#input) return;
          this.#oiKey = oiKey; this.#input = { ...this.#input, oi: interest }; this.#render();
        });
    }
    const [got, rest] = await Promise.all([answer, resting]);
    if (asked !== this.#asked || !this.#input) return;
    this.#lastMs = performance.now() - started;
    this.#input = { ...this.#input, answer: got.a, error: got.a ? null : /\b404\b/.test(got.e ?? '') ? 'older' : 'failed', resting: rest };
    this.#render();
    this.#schedule();
  }

  /** Take a live selection's figures again after a while, while its panel is open and the page is shown (the map's: a pane's draws itself). */
  #schedule(): void {
    window.clearTimeout(this.#timer); this.#timer = 0;
    const sel = this.store.state.range;
    if (!sel || sel.draft || !sel.live || !this.#panel || document.hidden || this.#context !== 'map') return;
    this.#timer = window.setTimeout(() => {
      // Nothing is due once it fired, whatever it does next (cancel() re-arms only when nothing is).
      this.#timer = 0;
      const now = this.store.state.range; if (!now || now.draft || !this.#panel) return;
      const moved = follow(now, Date.now());
      if (moved !== now) this.store.set({ range: moved });
      void this.#gather(moved, false);
    }, refreshMs(this.#lastMs, sel.t1 - sel.t0));
  }

  /** The Show menu: the map, each pane shown that sums up its own bars, and the summary shown now (its pane may have been hidden since). */
  #syncShow(): void {
    const options: [string, string][] = [['map', t('Map')]];
    for (const p of this.#providers.values()) { const shown = p.shown(); if (shown || p.pane === this.#context) options.push([p.pane, shown ? p.title() : `${p.title()} (${t('hidden')})`]); }
    const key = options.map(o => o.join(':')).join('|');
    if (this.#show.dataset.key !== key) { this.#show.dataset.key = key; this.#show.replaceChildren(...options.map(([value, text]) => new Option(text, value))); }
    if (this.#show.value !== this.#context) this.#show.value = this.#context;
    const label = this.#show.parentElement; if (label) label.hidden = options.length < 2;
  }

  #render(): void {
    const input = this.#input, sel = this.store.state.range, provider = this.#context !== 'map' ? this.#providers.get(this.#context) : undefined;
    this.#syncShow();
    const lines: RangeLine[] = sel && !sel.draft && provider ? provider.lines(sel, provider.shown())
      : input && sel && !sel.draft ? rangeLines(input)
      : [{ key: 'intro', kind: 'note', cells: [t('Drag across the map to select a box, or across a pane under it or the flow column for a stretch of time at every price. Ctrl+drag (Cmd on a Mac) selects at any time; Esc closes.')] }];
    const before = this.#lines.root.childElementCount;
    this.#lines.update(lines);
    if (this.#lines.root.childElementCount !== before) this.#panel?.reposition();
  }
}
