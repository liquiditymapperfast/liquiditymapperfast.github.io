import { setTip } from './tip.ts';
import { el } from './dom.ts';
import { openMenu, type MenuItem } from './menu.ts';
import { isCoarse, isPhone } from './device.ts';
import { t } from './i18n.ts';
import { arrangeOrder, defaultColumns, fitHeights, type PaneArrangement } from './layouts/layouts.ts';
import { SIDES, clonePlan, columnState, defaultPlan, laidOutWidths, leadOf, legacyPlan, maxColumnWidth, minWidthOf, moveSide, nudge, openIn, otherSide, readPlan, sideOf, splitWeights, swapSides, type DockPlan, type Side, type SidePaneId } from './layouts/dock-model.ts';
import { dropTarget, type Box, type DropScene, type DropTarget } from './layouts/dock-drop.ts';

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

export interface LayoutPane {
  id: string; root: HTMLElement; /** Initial height in px for fixed-height panes; the flexible pane has none. */ height?: number; min?: number; head?: HTMLElement | null;
  /** False for a pane whose switch is more than the pane's (the Scripts pane: its switch is the Scripts feature, which draws on the map too): it has no close button. */
  closable?: boolean;
}
/** A pane that stands beside the map: its header (the controls it has), and the name its edge tab and its buttons give it. */
export interface SidePane { id: SidePaneId; root: HTMLElement; head: HTMLElement; title: string }

/** A pane that can be moved by its header: a side pane or a pane under the map. */
interface Mover { id: string; kind: 'side' | 'strip'; root: HTMLElement; head: HTMLElement; title: () => string; closable: boolean }

/** The width of a column's splitter (px; the stylesheet's `.splitter` says the same). */
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
  readonly #movers = new Map<string, Mover>();
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
    for (const pane of sidePanes) { this.#sidePanes.set(pane.id, pane); this.#mover({ id: pane.id, kind: 'side', root: pane.root, head: pane.head, title: () => pane.title, closable: true }); }
    // Restore pane order and heights: the saved order, and a pane it does not know (one added since) after the others, so a new pane does
    // not undo a person's order.
    this.#panes = arrangeOrder(this.#saved.order ?? [], panes.map(p => ({ id: p.id, fixed: p.height !== undefined }))).map(id => panes.find(p => p.id === id)!);
    for (const pane of this.#panes) {
      if (pane.height !== undefined) this.#setHeight(pane, this.#saved.heights?.[pane.id] ?? pane.height);
      this.chart.append(pane.root);
      if (pane.head) this.#mover({ id: pane.id, kind: 'strip', root: pane.root, head: pane.head, title: () => pane.head!.querySelector('strong')?.textContent ?? pane.id, closable: pane.closable !== false });
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
    // A window that becomes a phone (or stops being one) is laid out again: a phone arranges its panes by tab, and the weights of a stack are the desktop's.
    let phone = isPhone();
    window.addEventListener('resize', () => { this.#fit(); if (isPhone() !== phone) { phone = !phone; this.#renderSides(); } else this.#applyColumns(); });
  }

  /** What a column is now: its width as it is laid out; one that is not laid out has none, so the width it keeps or the window's. */
  #width(side: Side): number {
    const laid = this.#regions[side].getBoundingClientRect().width;
    return Math.round(laid > 0 && this.#regions[side].dataset.state === 'open' ? laid : this.#wanted(side));
  }
  /** The width a column is asked for: the one dragged to, else what the stylesheet gives its lead pane (the book, the wider, where it is open in it) at this window. */
  #wanted(side: Side): number {
    const own = this.#plan[side === 'left' ? 'leftW' : 'rightW'];
    if (own !== null) return own;
    const wide = defaultColumns(window.innerWidth);
    return leadOf(this.#plan, side, this.#shown) === 'book' ? wide.sideW : wide.flowW;
  }
  /** A column made `w` wide, within what its panes need and what the map is to keep. */
  #setWidth(side: Side, w: number): void {
    const other = otherSide(side), otherW = columnState(this.#plan, other, this.#shown) === 'open' ? this.#width(other) : 0;
    const min = minWidthOf(openIn(this.#plan, side, this.#shown), isCoarse()), max = maxColumnWidth(window.innerWidth, otherW, min);
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
    // A splitter is a separator the keyboard can move too: the arrow keys along its axis, sixteen pixels a press, sixty-four with Shift.
    handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', moveY ? 'horizontal' : 'vertical'); handle.setAttribute('aria-label', t('Drag to resize'));
    handle.addEventListener('keydown', e => {
      const step = e.shiftKey ? 64 : 16, d = moveY ? (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) : (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0);
      if (!d) return;
      e.preventDefault(); start(); moveX?.(d); moveY?.(d); end();
    });
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
        // A phone shows one pane at a time and sizes it in the stylesheet: a share written here would beat that and leave the pane short of the area.
        pane.root.style.flex = open.length > 1 && !isPhone() ? `${this.#plan.weights[id] ?? 1} 1 0px` : '';
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
    let ah = 0, bh = 0;
    this.#drag(bar, null, () => { ah = a.getBoundingClientRect().height; bh = b.getBoundingClientRect().height; }, () => this.#persist(), dy => {
      const min = 90, span = ah + bh;
      if (!(span > 0)) return;
      // The pair's weights add up to 2 whatever they were (an imported plan may hold 10 and 10, which a drag would take past the limit a file is read back at).
      const [wa, wb] = splitWeights(Math.max(min, Math.min(span - min, ah + dy)) / span);
      this.#plan.weights[above] = wa; this.#plan.weights[below] = wb;
      a.style.flex = `${wa} 1 0px`; b.style.flex = `${wb} 1 0px`;
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
    const min = (side: Side): number => minWidthOf(openIn(this.#plan, side, this.#shown), isCoarse());
    const [lw, rw] = laidOutWidths([this.#wanted('left'), this.#wanted('right')], [min('left'), min('right')], [states.left === 'open', states.right === 'open'], wide);
    for (const side of SIDES) {
      const own = this.#plan[side === 'left' ? 'leftW' : 'rightW'], fitted = side === 'left' ? lw : rw, asked = this.#wanted(side);
      this.main.style.setProperty(side === 'left' ? '--left-w' : '--right-w', own === null && fitted === asked ? (leadOf(this.#plan, side, this.#shown) === 'book' ? 'var(--side-w)' : 'var(--flow-w)') : `${fitted}px`);
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
      // As on the columns' splitters (and the one between two side panes): a double click gives the panes it parts back their own height.
      bar.addEventListener('dblclick', () => this.#resetHeights([above, below]));
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

  /** What a pane is called (its header's title), for what is said about it. */
  title(id: string): string { return this.#movers.get(id)?.title() ?? id; }

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

  /**
   * What a pane carries to be moved and closed: a handle to drag it by (its place is the page's to change: either side of the map for a side
   * pane, between the panes under the map for the others), a menu of the same moves for a keyboard and a touch screen (also on a right click),
   * and a close button, which hides the pane (the page's switch for it; a side pane's edge tab brings it back). They sit in the pane's own header,
   * which is a handle all over where it holds no control: a pane under the map carries them at the end of it; a side pane, whose column can be
   * made as narrow as 200 px, keeps them on the first line behind its name (`.side-head` in styles.css) and lets its first controls join that
   * line where the column is wide. A title bar of its own above that header (Karl, 2026-11-01: "double header rows") left the header's first line
   * holding only the "?" and the settings key: three rows where two or one do.
   */
  #mover(m: Mover): void {
    this.#movers.set(m.id, m);
    const more = el('button', { type: 'button', class: 'pane-more', tip: t('Move, resize or hide this panel'), ariaLabel: t('Move, resize or hide this panel'), onclick: () => this.#menu(m, more) });
    const close = el('button', { type: 'button', class: 'panel-x pane-x', tip: t('Hide this panel'), ariaLabel: t('Hide this panel'), onclick: () => this.onClose(m.id) });
    close.dataset.pane = m.id;
    const tools = el('div', { class: 'pane-tools' }, more, ...(m.closable ? [close] : []));
    const handle = m.head;
    handle.prepend(el('span', { class: 'grip', tip: t('Drag to move this pane') }));
    if (m.kind === 'side') {
      // Behind the name, where the CSS puts them on the first line; the break after them ends that line where the pane's controls do not join it.
      handle.classList.add('side-head');
      const name = handle.querySelector(':scope > strong');
      const rest = [tools, el('span', { class: 'side-break', ariaHidden: 'true' })];
      if (name) name.after(...rest); else handle.append(...rest);
    } else {
      handle.classList.add('has-tools'); handle.append(tools);
    }
    handle.addEventListener('pointerdown', e => { if (!(e.target instanceof Element) || e.target.closest('button, select, input, textarea, a, label, canvas')) return; this.#startDrag(m, e); });
    handle.addEventListener('contextmenu', e => {
      if (isPhone() || !(e.target instanceof Element) || e.target.closest('select, input, textarea, button, a, canvas')) return;
      e.preventDefault(); this.#menu(m, more);
    });
  }

  /** The moves a pane's menu offers now: only those that go somewhere. */
  #menu(m: Mover, anchor: HTMLElement): void {
    const items: MenuItem[] = [];
    if (m.kind === 'side') {
      const id = m.id as SidePaneId, side = sideOf(this.#plan, id);
      items.push({ id: side === 'left' ? 'right' : 'left', label: side === 'left' ? t('Move to the right side') : t('Move to the left side') });
      if (nudge(this.#plan, id, -1, this.#shown) !== this.#plan) items.push({ id: 'up', label: t('Move up') });
      if (nudge(this.#plan, id, 1, this.#shown) !== this.#plan) items.push({ id: 'down', label: t('Move down') });
      items.push({ id: 'swap', label: t('Swap the two sides') });
    } else {
      const fixed = this.#panes.filter(p => !p.root.hidden && p.height !== undefined), i = fixed.findIndex(p => p.id === m.id);
      if (i > 0) items.push({ id: 'up', label: t('Move up') });
      if (i >= 0 && i < fixed.length - 1) items.push({ id: 'down', label: t('Move down') });
    }
    items.push({ id: 'reset', label: t('Reset the size') });
    if (m.closable) items.push({ id: 'hide', label: t('Hide this panel') });
    openMenu(anchor, items, '', { onPreview: () => {}, onSelect: action => this.#act(m, action) });
  }

  #act(m: Mover, action: string): void {
    if (action === 'hide') { this.onClose(m.id); return; }
    if (m.kind === 'side') {
      const id = m.id as SidePaneId, key = sideOf(this.#plan, id) === 'left' ? 'leftW' : 'rightW';
      if (action === 'left' || action === 'right') this.moveSidePane(id, action);
      else if (action === 'up' || action === 'down') { this.#plan = nudge(this.#plan, id, action === 'up' ? -1 : 1, this.#shown); this.#renderSides(); this.#persist(); }
      else if (action === 'swap') this.swapSides();
      else if (action === 'reset') { this.#plan[key] = null; for (const other of this.#plan[sideOf(this.#plan, id)]) delete this.#plan.weights[other]; this.#renderSides(); this.#persist(); }
      return;
    }
    const fixed = this.#panes.filter(p => !p.root.hidden && p.height !== undefined), i = fixed.findIndex(p => p.id === m.id), pane = fixed[i];
    if (action === 'up' && i > 0) this.#moveStrip(m.id, fixed[i - 1]!.id);
    else if (action === 'down' && i >= 0 && i < fixed.length - 1) this.#moveStrip(m.id, fixed[i + 2]?.id ?? null);
    else if (action === 'reset' && pane) this.#resetHeights([pane]);
  }

  /** The panes under the map (those with a height of their own) given back the height they start with; the map keeps what is left. */
  #resetHeights(panes: readonly LayoutPane[]): void {
    const heights = { ...this.#saved.heights };
    for (const pane of panes) {
      if (pane.height === undefined) continue;
      // Kept as that height, not left out: a window too short for it shows the pane smaller (`#fit`), and what is kept is what a taller window gives back.
      heights[pane.id] = pane.height; this.#setHeight(pane, pane.height);
    }
    this.#saved = { ...this.#saved, heights };
    this.#fit(); this.#persist();
  }

  /** A pane under the map put before `beforeId` (the last when that is null), among the panes under the map: the map keeps its own place. */
  #moveStrip(id: string, beforeId: string | null): void {
    if (isPhone()) return;
    const fixed = this.#panes.filter(p => p.height !== undefined).map(p => p.id).filter(x => x !== id);
    const at = beforeId === null ? -1 : fixed.indexOf(beforeId);
    if (at < 0) fixed.push(id); else fixed.splice(at, 0, id);
    const ids = arrangeOrder(fixed, this.#panes.map(p => ({ id: p.id, fixed: p.height !== undefined })));
    if (ids.join() === this.#panes.map(p => p.id).join()) return;
    this.#panes = ids.map(i => this.#panes.find(p => p.id === i)!);
    this.#reattach(); this.#persist();
  }

  /** The page measured for `dropTarget`: where the columns, the panes in them and the map's column are now. */
  #scene(): DropScene {
    const box = (node: Element): Box => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const column = (side: Side): DropScene['columns'][Side] => {
      const region = this.#regions[side], open = region.dataset.state === 'open';
      return { box: box(region), open, panes: open ? openIn(this.#plan, side, this.#shown).map(id => ({ id, box: box(this.#sidePanes.get(id)!.root) })) : [] };
    };
    return {
      main: box(this.main), edge: Math.max(260, Math.round(window.innerWidth * 0.2)), columns: { left: column('left'), right: column('right') },
      strip: { box: box(this.chart), panes: this.#panes.filter(p => !p.root.hidden).map(p => ({ id: p.id, box: box(p.root), fixed: p.height !== undefined })) },
    };
  }

  /**
   * Drag a pane by its grip: a small label follows the pointer and a mark shows where the pane would stand (a bar between two panes, a strip
   * along the edge where a column is not there); letting go moves it there, Escape or a drop anywhere else leaves it.
   */
  #startDrag(m: Mover, down: PointerEvent): void {
    if (down.button !== 0 || isPhone()) return;
    down.preventDefault();
    const grip = down.currentTarget as HTMLElement;
    try { grip.setPointerCapture(down.pointerId); } catch { /* the drag does not need it */ }
    const drag = m.kind === 'side' ? { kind: 'side' as const, id: m.id as SidePaneId } : { kind: 'strip' as const, id: m.id };
    let live = false, target: DropTarget | null = null, scene: DropScene | null = null, ghost: HTMLElement | null = null, mark: HTMLElement | null = null;
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== down.pointerId) return;
      if (!live) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
        live = true; scene = this.#scene();
        document.body.classList.add('pane-dragging'); m.root.classList.add('moving');
        ghost = el('div', { class: 'pane-ghost' }, el('i', { class: 'grip-mark' }), el('span', { textContent: m.title() }));
        mark = el('div', { class: 'drop-mark', hidden: true });
        document.body.append(mark, ghost);
      }
      ghost!.style.transform = `translate(${Math.round(e.clientX + 14)}px, ${Math.round(e.clientY + 12)}px)`;
      target = dropTarget(scene!, drag, e.clientX, e.clientY);
      mark!.hidden = target === null;
      if (target) {
        mark!.className = target.kind === 'side' && target.area ? 'drop-mark area' : 'drop-mark';
        Object.assign(mark!.style, { left: `${target.box.x}px`, top: `${target.box.y}px`, width: `${target.box.w}px`, height: `${target.box.h}px` });
      }
    };
    const stop = (commit: boolean): void => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key, true);
      try { grip.releasePointerCapture(down.pointerId); } catch { /* it was never held */ }
      ghost?.remove(); mark?.remove(); document.body.classList.remove('pane-dragging'); m.root.classList.remove('moving');
      if (live && commit && target) { if (target.kind === 'side') this.moveSidePane(m.id as SidePaneId, target.side, target.beforeId); else this.#moveStrip(m.id, target.beforeId); }
    };
    const up = (e: PointerEvent): void => { if (e.pointerId === down.pointerId) stop(true); };
    const cancel = (e: PointerEvent): void => { if (e.pointerId === down.pointerId) stop(false); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(false); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key, true);
  }
  #reattach(): void { for (const p of this.#panes) this.chart.append(p.root); this.rebuild(); }
}
