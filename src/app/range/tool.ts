import type { Store } from '../store.ts';
import type { Hub } from '../hub.ts';
import { el } from '../dom.ts';
import { openPanel, openedPanel, type Panel } from '../ui.ts';
import { helpButton } from '../help.ts';
import { compactBar } from '../device.ts';
import { activeIds, kindOf } from '../scope.ts';
import { flowIds } from '../cvd/ids.ts';
import { gridStepFor } from '../../shared/grid.ts';
import { t } from '../i18n.ts';
import { draftOf, follow, refreshMs, rowStep, snap, type RangeSelection } from './selection.ts';
import { rangeLines, type RangeInput, type RangeLine } from './stats.ts';
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
      const sig = JSON.stringify([line.kind, line.cells, line.share, line.bars, line.tone, line.mark]);
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
    case 'stat': return el('div', { class: `range-stat${tone}` }, el('span', { class: 'label', textContent: line.cells[0] ?? '' }), el('span', { class: 'value', textContent: line.cells[1] ?? '' }));
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
  #lastMs = 0;
  #timer = 0;
  #stopping = false;
  /** The toolbar's button: the panel opens beside it. */
  anchor: HTMLElement | null = null;
  /** The map's time window (set by the page): the absorption marks and the large orders are loaded for it, and for no other. */
  mapWindow: () => { t0: number; t1: number } | null = () => null;

  constructor(private store: Store, private hub: Hub) {
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && this.#start) { e.preventDefault(); this.cancel(); } });
    document.addEventListener('visibilitychange', () => this.#schedule());
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
    else if (sel && !sel.draft) { this.#open(); void this.#gather(sel, false); }
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
    window.clearTimeout(this.#timer); this.#timer = 0; this.#asked++;
    this.#start = null; this.#before = null; this.#input = null;
    this.store.set({ rangeTool: false, range: null });
    this.#panel?.close(); this.#panel = null;
    this.#stopping = false;
  }

  begin(at: RangePoint): void {
    this.#start = at; this.#before = this.store.state.range?.draft === false ? this.store.state.range : null;
    this.store.set({ range: draftOf(at, at) });
  }
  /** The drag is at `at`; `from` moves where it began too (a drag on the traded column holds whole rows, so both ends snap). */
  move(at: RangePoint, from?: RangePoint): void { if (!this.#start) return; if (from) this.#start = from; this.store.set({ range: draftOf(this.#start, at) }); }
  /** The drag ended at `at` (and began at `from`, when given). `small`: it covered too few pixels to be a selection (a click), and what was selected before stays. */
  end(at: RangePoint, small: boolean, from?: RangePoint): void {
    if (from && this.#start) this.#start = from;
    const start = this.#start; if (!start) return;
    if (small) { this.cancel(); return; }
    this.#start = null; this.#before = null;
    // Replay: snapped on its clock, up to its moment, and never live (the live refresh would move it with the real now).
    const snapped = snap(draftOf(start, at), pageNow()), sel = replaying() ? { ...snapped, t1: Math.min(snapped.t1, Math.ceil(pageNow() / 60_000) * 60_000), live: false } : snapped;
    this.store.set({ range: sel, rangeTool: false });
    this.#open();
    void this.#gather(sel, true);
  }
  cancel(): void {
    if (!this.#start) return;
    this.#start = null;
    this.store.set({ range: this.#before }); this.#before = null;
  }

  #open(): void {
    if (this.#panel || !this.anchor) return;
    const again = el('button', { type: 'button', textContent: t('New selection'), tip: t('Select another part of the map or of a pane: drag across it.'), onclick: () => { this.store.set({ rangeTool: true }); this.#render(); } });
    this.#panel = openPanel(this.anchor, { title: t('Range'), width: 420, align: 'left', stays: true, onClose: () => { this.#panel = null; window.clearTimeout(this.#timer); this.#timer = 0; queueMicrotask(() => { if (!openedPanel()) this.stop(); }); } }, (tools, body) => {
      tools.append(again, el('span', { class: 'spacer' }), helpButton('range'));
      body.append(this.#lines.root);
    });
  }

  /**
   * What the map holds inside `sel` (the absorption marks, the large orders and the liquidations), read from the hub as it is now. The marks
   * and the large orders are loaded for the map's window: a selection reaching outside it (across the flow column on a longer span) has them
   * only for its part on the map.
   */
  #held(sel: RangeSelection): Pick<RangeInput, 'marks' | 'prints' | 'liquidations' | 'liquidationMin' | 'kind' | 'partial'> {
    const state = this.store.state, ids = flowIds(state, this.hub.flow.ids), idSet = new Set(ids);
    const band = sel.p0 !== null && sel.p1 !== null ? { p0: sel.p0, p1: sel.p1 } : null;
    const inside = (time: number, price: number): boolean => time >= sel.t0 && time < sel.t1 && (!band || (price >= band.p0 && price < band.p1));
    const s = state.absorption, now = Date.now();
    const marks = s.on ? this.hub.absorption.marks(ids, this.hub.absorption.thresholds(ids, s, now), sel.t0, sel.t1, band?.p0 ?? 0, band?.p1 ?? Infinity).filter(m => inside(m.t0, m.price)) : null;
    const prints = state.show.bubbles ? this.hub.prints.items.filter(p => idSet.has(p.id) && inside(p.t, p.price)) : null;
    const liquidations = state.liquidations.on ? this.hub.liquidations.items.filter(l => idSet.has(l.id) && inside(l.t, l.price)) : null;
    const kind = (id: string) => kindOf(state.markets, id);
    const map = this.mapWindow(), partial = map !== null && (sel.t0 < map.t0 || (!sel.live && sel.t1 > map.t1));
    return { marks, prints, liquidations, liquidationMin: scaledUsd(state.liquidations.minUsd), kind, partial };
  }

  /**
   * Read again what the map holds for the selection on show (its large orders or liquidations arrived after it was made, or their settings
   * changed), without asking the recording again; at most once a frame.
   */
  refreshHeld(): void {
    if (this.#heldFrame || !this.#panel || !this.#input) return;
    this.#heldFrame = requestAnimationFrame(() => {
      this.#heldFrame = 0;
      const sel = this.store.state.range, input = this.#input;
      if (!sel || sel.draft || !input || !this.#panel || input.sel !== sel) return;
      this.#input = { ...input, ...this.#held(sel) };
      this.#render();
    });
  }
  #heldFrame = 0;

  /** Gather everything for `sel` and show it; `fresh` when it is a new selection rather than a live one taken again. */
  async #gather(sel: RangeSelection, fresh: boolean): Promise<void> {
    const asked = ++this.#asked;
    window.clearTimeout(this.#timer); this.#timer = 0;
    const state = this.store.state, ids = flowIds(state, this.hub.flow.ids);
    const band = sel.p0 !== null && sel.p1 !== null ? { p0: sel.p0, p1: sel.p1 } : null;
    const kept = !fresh && this.#input ? this.#input : null;
    this.#input = { sel, answer: kept?.answer ?? null, error: null, resting: kept?.resting ?? null, oi: kept && kept.oi !== undefined ? kept.oi : 'asking', ...this.#held(sel) };
    this.#render();
    const started = performance.now(), mark = state.mark.price > 0 ? state.mark.price : band ? (band.p0 + band.p1) / 2 : 0;
    const step = rowStep(sel, gridStepFor(mark > 0 ? mark : 1));
    const answer = this.hub.source.range(ids, sel.t0, sel.t1, band, step).then(a => ({ a, e: null }), (e: unknown) => ({ a: null, e: e instanceof Error ? e.message : String(e) }));
    const resting = band ? this.hub.cell(activeIds(state), sel.t0, sel.t1, band.p0, band.p1) : Promise.resolve(null);
    // The open interest of the market the OI pane shows, a sample a minute, from a little before the selection.
    const oiInst = state.oiInstrument || state.seriesInstrument || state.marketId, market = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId);
    const oi = oiInst ? this.hub.source.oi(oiInst, '1m', sel.t0 - 11 * 60_000, sel.t1 + 60_000).then(bars => bars.length ? { inst: oiInst, bars, coin: market?.base ?? '', price: state.mark.price } : null, () => null) : Promise.resolve(null);
    const [got, rest, interest] = await Promise.all([answer, resting, oi]);
    if (asked !== this.#asked || !this.#input) return;
    this.#lastMs = performance.now() - started;
    this.#input = { ...this.#input, answer: got.a, error: got.a ? null : /\b404\b/.test(got.e ?? '') ? 'older' : 'failed', resting: rest, oi: interest };
    this.#render();
    this.#schedule();
  }

  /** Take a live selection's figures again after a while, while its panel is open and the page is shown. */
  #schedule(): void {
    window.clearTimeout(this.#timer); this.#timer = 0;
    const sel = this.store.state.range;
    if (!sel || sel.draft || !sel.live || !this.#panel || document.hidden) return;
    this.#timer = window.setTimeout(() => {
      const now = this.store.state.range; if (!now || now.draft || !this.#panel) return;
      const moved = follow(now, Date.now());
      if (moved !== now) this.store.set({ range: moved });
      void this.#gather(moved, false);
    }, refreshMs(this.#lastMs, sel.t1 - sel.t0));
  }

  #render(): void {
    const input = this.#input, sel = this.store.state.range;
    const lines: RangeLine[] = input && sel && !sel.draft ? rangeLines(input)
      : [{ key: 'intro', kind: 'note', cells: [t('Drag across the map to select a box, or across a pane under it or the flow column for a stretch of time at every price. Ctrl+drag (Cmd on a Mac) selects at any time; Esc closes.')] }];
    const before = this.#lines.root.childElementCount;
    this.#lines.update(lines);
    if (this.#lines.root.childElementCount !== before) this.#panel?.reposition();
  }
}
