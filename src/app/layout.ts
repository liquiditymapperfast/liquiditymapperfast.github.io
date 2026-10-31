import { setTip } from './tip.ts';
import { el } from './dom.ts';
import { isPhone } from './device.ts';
import { t } from './i18n.ts';
import { arrangeOrder, defaultColumns, fitHeights, type PaneArrangement } from './layouts/layouts.ts';
import { SIDES, clonePlan, columnState, defaultPlan, fitColumns, legacyPlan, maxColumnWidth, minWidthOf, moveSide, openIn, otherSide, readPlan, sideOf, swapSides, type DockPlan, type Side, type SidePaneId } from './layouts/dock-model.ts';

/**
 * Resizable, reorderable layout, kept in localStorage. The map's column holds the map and the panes under it (splitters between them, a grip
 * on each header to reorder); the flow column and the order book stand beside it, each on the side the plan says (`layouts/dock-model.ts`),
 * alone or one over the other. A column with nothing open shows an edge tab for each pane it holds, which opens it again.
 */
interface Saved { order?: string[]; heights?: Record<string, number>; dock?: unknown }
const KEY = 'hlm-layout-v3', V2_KEY = 'hlm-layout-v2';
/** The widths the columns had before they followed the window (420 and 300): a save holding one was written by a save of something else (a height), not by a drag. */
const OLD_SIDE_W = 420, OLD_FLOW_W = 300;

/** The saved arrangement: this version's, or the one before it (`hlm-layout-v2`: the flow column left of the map and the book right of it, a width kept only where a drag set it), read as this version's. */
function read(): Saved {
  try {
    const now = window.localStorage.getItem(KEY);
    const raw = JSON.parse(now ?? window.localStorage.getItem(V2_KEY) ?? '{}') as Record<string, unknown>;
    const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === 'string') : undefined;
    const heights: Record<string, number> = {};
    if (raw.heights && typeof raw.heights === 'object') for (const [id, h] of Object.entries(raw.heights as Record<string, unknown>)) if (typeof h === 'number' && Number.isFinite(h)) heights[id] = h;
    return { order, heights, dock: now !== null ? raw.dock : legacyPlan(raw.flowW, raw.sideW, OLD_FLOW_W, OLD_SIDE_W) };
  } catch { return {}; }
}
function write(saved: Saved): void { try { window.localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ } }

export interface LayoutPane { id: string; root: HTMLElement; /** Initial height in px for fixed-height panes; the flexible pane has none. */ height?: number; min?: number; head?: HTMLElement | null }
/** A pane that stands beside the map: its header (the controls it has), and the name its edge tab and its buttons give it. */
export interface SidePane { id: SidePaneId; root: HTMLElement; head: HTMLElement; title: string }

/** The width of a column's splitter, and of the strip a column with nothing open leaves (px; the stylesheet's `--rail-w` says the same). */
const SPLIT_W = 6;

export class Layout {
  #saved = read();
  #panes: LayoutPane[];
  readonly #splitters: HTMLElement[] = [];
  /** Which side pane is where, and how wide each column is (null: it follows the window, as the stylesheet sizes it). */
  #plan: DockPlan;
  /** Which of the side panes are open (the page's switches). */
  #shown: Record<SidePaneId, boolean> = { cvd: true, book: true };
  readonly #sidePanes = new Map<SidePaneId, SidePane>();
  /** The columns beside the map, the splitter between each and the map, and the tabs a column with nothing open shows. */
  readonly #regions: Record<Side, HTMLElement>;
  readonly #vsplit = {} as Record<Side, HTMLElement>;
  readonly #rails = {} as Record<Side, HTMLElement>;
  #railKeys: Record<Side, string> = { left: '', right: '' };
  readonly #stackBars = new Map<string, HTMLElement>();
  /** The heights `#fit` last gave the panes under the map: a pane still at one of them was not resized by hand, and keeps its own height when saved. */
  #fitted = new Map<string, number>();
  /** The arrangement the page starts with when nothing is saved (the Default layout). */
  readonly #defaults: PaneArrangement;
  /** What the close button of a pane, and the edge tab of a closed one, do (the page's switches are the page's). */
  onClose: (id: string) => void = () => {};
  onOpen: (id: string) => void = () => {};

  constructor(private main: HTMLElement, private chart: HTMLElement, regions: Record<Side, HTMLElement>, panes: LayoutPane[], sidePanes: SidePane[]) {
    this.#panes = panes;
    this.#regions = regions;
    this.#plan = readPlan(this.#saved.dock) ?? defaultPlan();
    this.#defaults = { order: panes.map(p => p.id), heights: Object.fromEntries(panes.flatMap(p => p.height !== undefined ? [[p.id, p.height]] : [])), ...defaultColumns(window.innerWidth), dock: defaultPlan() };
    for (const pane of sidePanes) { this.#sidePanes.set(pane.id, pane); this.#tools(pane.id, pane.head); }
    // Restore pane order and heights: the saved order, and a pane it does not know (one added since) after the others, so a new pane does
    // not undo a person's order.
    this.#panes = arrangeOrder(this.#saved.order ?? [], panes.map(p => ({ id: p.id, fixed: p.height !== undefined }))).map(id => panes.find(p => p.id === id)!);
    for (const pane of this.#panes) {
      if (pane.height !== undefined) this.#setHeight(pane, this.#saved.heights?.[pane.id] ?? pane.height);
      this.chart.append(pane.root);
      if (pane.head) { this.#grip(pane); this.#tools(pane.id, pane.head); }
    }
    // The splitters between the map and each column; a drag sets that column's width, a double click gives it back to the window.
    for (const side of SIDES) {
      const bar = this.#vsplit[side] = el('div', { class: 'splitter v', tip: t('Drag to resize') });
      this.main.insertBefore(bar, side === 'left' ? this.chart : regions.right);
      let start = 0;
      this.#drag(bar, dx => this.#setWidth(side, side === 'left' ? start + dx : start - dx), () => { start = this.#width(side); }, () => this.#persist());
      bar.addEventListener('dblclick', () => { this.#plan[side === 'left' ? 'leftW' : 'rightW'] = null; this.#applyColumns(); this.#persist(); });
      const rail = this.#rails[side] = el('div', { class: 'edge-rail' });
      regions[side].append(rail);
    }
    this.rebuild();
    this.#renderSides();
    window.addEventListener('resize', () => { this.#fit(); this.#applyColumns(); });
  }

  /** What a column is now: its width as it is laid out; one that is not laid out has none, so the width it keeps or the window's. */
  #width(side: Side): number {
    const laid = this.#regions[side].getBoundingClientRect().width;
    return Math.round(laid > 0 && this.#regions[side].dataset.state === 'open' ? laid : this.#wanted(side));
  }
  /** The width a column is asked for: the one dragged to, else what the stylesheet gives the first pane in it at this window. */
  #wanted(side: Side): number {
    const own = this.#plan[side === 'left' ? 'leftW' : 'rightW'];
    if (own !== null) return own;
    const first = this.#plan[side].find(id => this.#shown[id]) ?? this.#plan[side][0], wide = defaultColumns(window.innerWidth);
    return first === 'book' ? wide.sideW : wide.flowW;
  }
  /** A column made `w` wide, within what its panes need and what the map is to keep. */
  #setWidth(side: Side, w: number): void {
    const other = otherSide(side), otherW = columnState(this.#plan, other, this.#shown) === 'open' ? this.#width(other) : 0;
    const min = minWidthOf(openIn(this.#plan, side, this.#shown)), max = maxColumnWidth(window.innerWidth, otherW, min);
    this.#plan[side === 'left' ? 'leftW' : 'rightW'] = Math.round(Math.max(min, Math.min(max, w)));
    this.#applyColumns();
  }

  #height(pane: LayoutPane): number { return pane.root.getBoundingClientRect().height; }
  #setHeight(pane: LayoutPane, h: number): void { pane.root.style.flex = `0 0 ${Math.round(Math.max(pane.min ?? 70, h))}px`; }
  #persist(): void {
    // A phone arranges panes by tab, not by drag: what it measures must not overwrite the sizes chosen on a desktop.
    if (isPhone()) return;
    const heights: Record<string, number> = {};
    for (const p of this.#panes) {
      if (p.height === undefined || p.root.hidden) continue;
      // A pane shrunk to fit the window keeps the height it was given; one resized by hand since gets its new one.
      const shown = Math.round(this.#height(p)), fitted = this.#fitted.get(p.id), own = this.#saved.heights?.[p.id];
      heights[p.id] = fitted !== undefined && own !== undefined && Math.abs(shown - fitted) <= 1 ? own : shown;
    }
    write({ heights: { ...this.#saved.heights, ...heights }, order: this.#panes.map(p => p.id), dock: this.#plan });
    this.#saved = read();
  }

  /** Pointer-drag helper: calls `move(totalDx, totalDy)` while a button is held on `handle`. */
  #drag(handle: HTMLElement, moveX: ((dx: number) => void) | null, start: () => void, end: () => void, moveY?: (dy: number) => void): void {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId); start(); handle.classList.add('active');
      const x0 = e.clientX, y0 = e.clientY;
      const onMove = (m: PointerEvent) => { moveX?.(m.clientX - x0); moveY?.(m.clientY - y0); };
      const onUp = () => { handle.classList.remove('active'); handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); handle.removeEventListener('pointercancel', onUp); end(); };
      handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', onUp); handle.addEventListener('pointercancel', onUp);
    });
  }

  /**
   * Tell the layout which of the side panes are open. A column with an open pane is laid out; one with none shows an edge tab for each pane it
   * holds (a pane that was closed keeps its place); one that holds none is not there. All instant: nothing is rebuilt, a pane or a column that
   * is not shown is simply not laid out.
   */
  sides(shown: Readonly<Record<SidePaneId, boolean>>): void {
    this.#shown = { cvd: shown.cvd, book: shown.book };
    for (const pane of this.#sidePanes.values()) pane.root.hidden = !shown[pane.id];
    this.#renderSides();
  }

  /** Put each side pane in its column, in the plan's order, with a splitter between two that are open and the edge tabs of a column that has none open. */
  #renderSides(): void {
    for (const side of SIDES) {
      const region = this.#regions[side], list = this.#plan[side], open = openIn(this.#plan, side, this.#shown);
      const nodes: HTMLElement[] = [];
      let above: SidePaneId | null = null;
      for (const id of list) {
        const pane = this.#sidePanes.get(id); if (!pane) continue;
        if (this.#shown[id] && above !== null) nodes.push(this.#stackBar(above, id));
        nodes.push(pane.root);
        pane.root.style.flex = open.length > 1 ? `${this.#plan.weights[id] ?? 1} 1 0px` : '';
        if (this.#shown[id]) above = id;
      }
      const closed = list.filter(id => !this.#shown[id]);
      this.#railTabs(side, closed);
      nodes.push(this.#rails[side]);
      // Only what is out of place is moved: a pane taken out of the page and put back loses what it scrolls and what it has focused.
      for (const old of [...region.children]) if (!nodes.includes(old as HTMLElement)) old.remove();
      nodes.forEach((node, i) => { if (region.children[i] !== node) region.insertBefore(node, region.children[i] ?? null); });
    }
    this.#applyColumns();
  }

  /** The splitter between two panes standing one over the other in a column: it shares the column's height between them (one per pair, kept). */
  #stackBar(above: SidePaneId, below: SidePaneId): HTMLElement {
    const key = `${above}>${below}`, kept = this.#stackBars.get(key);
    if (kept) return kept;
    const bar = el('div', { class: 'splitter h', tip: t('Drag to resize') });
    const a = this.#sidePanes.get(above)!.root, b = this.#sidePanes.get(below)!.root;
    let ah = 0, bh = 0, total = 1;
    this.#drag(bar, null, () => { ah = a.getBoundingClientRect().height; bh = b.getBoundingClientRect().height; total = ((this.#plan.weights[above] ?? 1) + (this.#plan.weights[below] ?? 1)); }, () => this.#persist(), dy => {
      const min = 90, span = ah + bh, na = Math.max(min, Math.min(span - min, ah + dy));
      const wa = total * na / span;
      this.#plan.weights[above] = Math.round(wa * 1000) / 1000; this.#plan.weights[below] = Math.round((total - wa) * 1000) / 1000;
      a.style.flex = `${this.#plan.weights[above]} 1 0px`; b.style.flex = `${this.#plan.weights[below]} 1 0px`;
    });
    bar.addEventListener('dblclick', () => { delete this.#plan.weights[above]; delete this.#plan.weights[below]; this.#renderSides(); this.#persist(); });
    this.#stackBars.set(key, bar);
    return bar;
  }

  /** An edge tab for each closed pane of a column: the column is a strip along the window's edge until one is pressed. */
  #railTabs(side: Side, closed: readonly SidePaneId[]): void {
    const key = closed.join();
    if (this.#railKeys[side] === key) return;
    this.#railKeys[side] = key;
    this.#rails[side].replaceChildren(...closed.map(id => {
      const title = this.#sidePanes.get(id)?.title ?? id;
      const tab = el('button', { type: 'button', class: 'edge-tab', tip: t('Show {name}', { name: title }), ariaLabel: t('Show {name}', { name: title }), onclick: () => this.onOpen(id) }, el('i', { class: 'edge-chev', ariaHidden: 'true' }), el('span', { textContent: title }));
      tab.dataset.pane = id;
      return tab;
    }));
  }

  /** Lay the columns out: which are there, how wide, and the grid of the page that holds them. */
  #applyColumns(): void {
    const states = { left: columnState(this.#plan, 'left', this.#shown), right: columnState(this.#plan, 'right', this.#shown) };
    for (const side of SIDES) {
      this.#regions[side].hidden = states[side] === 'none'; this.#regions[side].dataset.state = states[side]; this.#regions[side].dataset.side = side;
      this.#vsplit[side].hidden = states[side] !== 'open';
    }
    // A phone's columns are the stylesheet's (mobile.css): the desktop's template written here beat its landscape grid and left the pane beside the map 0 to 120 px wide.
    if (isPhone()) { this.main.style.removeProperty('grid-template-columns'); return; }
    // The widths: the stylesheet's own (it follows the window) for a column that was not dragged, the dragged one otherwise, and both taken down together when they would leave the map too little.
    const wide = window.innerWidth;
    const want = (side: Side): number => this.#wanted(side), min = (side: Side): number => minWidthOf(openIn(this.#plan, side, this.#shown));
    const both = states.left === 'open' && states.right === 'open';
    const [lw, rw] = both ? fitColumns(want('left'), want('right'), wide, min('left'), min('right')) : [want('left'), want('right')];
    for (const side of SIDES) {
      const own = this.#plan[side === 'left' ? 'leftW' : 'rightW'], fitted = side === 'left' ? lw : rw, first = openIn(this.#plan, side, this.#shown)[0] ?? this.#plan[side][0];
      const asked = this.#wanted(side);
      this.main.style.setProperty(side === 'left' ? '--left-w' : '--right-w', own === null && fitted === asked ? (first === 'book' ? 'var(--side-w)' : 'var(--flow-w)') : `${fitted}px`);
    }
    const tracks: string[] = [];
    if (states.left === 'open') tracks.push('var(--left-w)', `${SPLIT_W}px`); else if (states.left === 'rail') tracks.push('var(--rail-w)');
    tracks.push('minmax(0,1fr)');
    if (states.right === 'open') tracks.push(`${SPLIT_W}px`, 'var(--right-w)'); else if (states.right === 'rail') tracks.push('var(--rail-w)');
    this.main.style.gridTemplateColumns = tracks.join(' ');
  }

  /** Recreate the horizontal splitters between visible panes (call after panes are shown, hidden or reordered). */
  rebuild(): void {
    for (const s of this.#splitters.splice(0)) s.remove();
    const visible = this.#panes.filter(p => !p.root.hidden);
    visible.forEach((below, i) => {
      if (i === 0) return;
      const above = visible[i - 1]!;
      const bar = document.createElement('div'); bar.className = 'splitter h'; setTip(bar, t('Drag to resize'));
      this.chart.insertBefore(bar, below.root); this.#splitters.push(bar);
      let aboveStart = 0, belowStart = 0;
      this.#drag(bar, null, () => { aboveStart = this.#height(above); belowStart = this.#height(below); }, () => this.#persist(), dy => {
        // The flexible pane absorbs the change; between two fixed panes the boundary moves.
        if (below.height !== undefined) this.#setHeight(below, belowStart - dy);
        if (above.height !== undefined) this.#setHeight(above, aboveStart + dy);
      });
    });
    this.#fit();
  }

  /**
   * The panes under the map at their own heights, or shrunk in proportion when they would leave the map too little of the column (`fitHeights`).
   * Their own heights are kept, so a taller window gets them back. Not on a phone, which shows one pane at a time.
   */
  #fit(): void {
    if (isPhone()) return;
    const fixed = this.#panes.filter(p => !p.root.hidden && p.height !== undefined);
    const avail = this.chart.clientHeight - this.#splitters.length * 6;
    if (!fixed.length || avail <= 0) return;
    const flexible = this.#panes.filter(p => !p.root.hidden && p.height === undefined), mapMin = flexible.reduce((sum, p) => sum + (parseFloat(getComputedStyle(p.root).minHeight) || 0), 0);
    const want = fixed.map(p => this.#saved.heights?.[p.id] ?? p.height!), heights = fitHeights(want, fixed.map(p => p.min ?? 70), avail, Math.max(mapMin, 1));
    this.#fitted.clear();
    fixed.forEach((p, i) => { this.#setHeight(p, heights[i]!); if (heights[i] !== want[i]) this.#fitted.set(p.id, heights[i]!); });
  }

  /** The arrangement the page starts with when nothing is saved. */
  defaults(): PaneArrangement { return { ...this.#defaults, ...defaultColumns(window.innerWidth), order: [...this.#defaults.order], heights: { ...this.#defaults.heights }, dock: defaultPlan() }; }

  /** The panes as they are now: order, heights (a hidden pane's as it will come back), which side each side pane is on, and the column widths. */
  arrangement(): PaneArrangement {
    const heights: Record<string, number> = {};
    // A pane shrunk to fit this window keeps its own height (as #persist does); a hidden one the height it will come back at.
    for (const p of this.#panes) {
      if (p.height === undefined) continue;
      const own = this.#saved.heights?.[p.id] ?? p.height;
      heights[p.id] = Math.round(p.root.hidden || this.#fitted.has(p.id) ? own : this.#height(p));
    }
    return { order: this.#panes.map(p => p.id), heights, sideW: this.#width(sideOf(this.#plan, 'book')), flowW: this.#width(sideOf(this.#plan, 'cvd')), dock: clonePlan(this.#plan) };
  }

  /**
   * Arrange the panes as `a` says (a saved layout): their order (panes it does not know after the others), every fixed pane's height,
   * hidden ones too so they come back at it, which side the flow column and the book stand on and the column widths; then keep it as the
   * page's own. A layout from before the side panes could move has none of that: the flow column is left of the map and the book right of it.
   * Not on a phone, which arranges by tab.
   */
  apply(a: PaneArrangement): void {
    if (isPhone()) return;
    const known = this.#defaults.order.map(id => ({ id, fixed: this.#defaults.heights[id] !== undefined }));
    const ids = arrangeOrder(a.order, known);
    this.#panes = ids.map(id => this.#panes.find(p => p.id === id)!);
    const heights: Record<string, number> = { ...this.#saved.heights };
    for (const p of this.#panes) if (p.height !== undefined) { const h = a.heights[p.id] ?? heights[p.id] ?? p.height; this.#setHeight(p, h); heights[p.id] = Math.round(Math.max(p.min ?? 70, h)); }
    // A width that is the default for this window is not a hand's: the column goes back to following the window.
    const wide = defaultColumns(window.innerWidth);
    this.#plan = a.dock ? clonePlan(a.dock) : legacyPlan(a.flowW, a.sideW, wide.flowW, wide.sideW);
    // What was asked for, not what is measured (a pane hidden now has no height to measure); kept first, as the fit reads it.
    write({ heights, order: ids, dock: this.#plan });
    this.#saved = read();
    this.#renderSides();
    this.#reattach();
  }

  /** Move a side pane to `side`, before `beforeId` in that column (the end of it when null). */
  moveSidePane(id: SidePaneId, side: Side, beforeId: SidePaneId | null = null): void {
    if (isPhone()) return;
    this.#plan = moveSide(this.#plan, id, side, beforeId, this.#shown);
    this.#renderSides(); this.#persist();
  }
  /** The two columns exchanged: what stood on the left stands on the right. */
  swapSides(): void {
    if (isPhone()) return;
    this.#plan = swapSides(this.#plan);
    this.#renderSides(); this.#persist();
  }

  /** Set a fixed-height pane's height (its content changed size) and remember it. */
  setPaneHeight(id: string, h: number): void {
    const pane = this.#panes.find(candidate => candidate.id === id);
    if (!pane || pane.height === undefined) return;
    this.#setHeight(pane, h); this.#persist();
  }

  /** The close button at the end of a pane's header: it hides the pane (the page's switch for it), and a side pane's edge tab brings it back. */
  #tools(id: string, head: HTMLElement): void {
    const close = el('button', { type: 'button', class: 'panel-x pane-x', tip: t('Hide this panel'), ariaLabel: t('Hide this panel'), onclick: () => this.onClose(id) });
    close.dataset.pane = id;
    head.classList.add('has-tools');
    head.append(el('div', { class: 'pane-tools' }, close));
  }

  /** Header grip that reorders fixed panes by dragging over their neighbours. */
  #grip(pane: LayoutPane): void {
    const grip = document.createElement('span'); grip.className = 'grip'; setTip(grip, t('Drag to move this pane'));
    pane.head!.prepend(grip);
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); grip.setPointerCapture(e.pointerId); pane.root.classList.add('moving');
      const onMove = (m: PointerEvent) => {
        const others = this.#panes.filter(p => p !== pane && !p.root.hidden && p.height !== undefined);
        for (const other of others) {
          const r = other.root.getBoundingClientRect(), mid = r.top + r.height / 2;
          const i = this.#panes.indexOf(pane), j = this.#panes.indexOf(other);
          if ((j < i && m.clientY < mid) || (j > i && m.clientY > mid)) { this.#panes.splice(i, 1); this.#panes.splice(j, 0, pane); this.#reattach(); break; }
        }
      };
      const onUp = () => { pane.root.classList.remove('moving'); grip.removeEventListener('pointermove', onMove); grip.removeEventListener('pointerup', onUp); this.#persist(); };
      grip.addEventListener('pointermove', onMove); grip.addEventListener('pointerup', onUp);
    });
  }
  #reattach(): void { for (const p of this.#panes) this.chart.append(p.root); this.rebuild(); }
}
