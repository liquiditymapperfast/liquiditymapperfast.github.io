import { setTip } from './tip.ts';
import { isPhone } from './device.ts';
import { t } from './i18n.ts';
import { arrangeOrder, fitHeights, type PaneArrangement } from './layouts/layouts.ts';
/** Resizable, reorderable layout: splitters between panes, persisted in localStorage. */
interface Saved { sideW?: number; flowW?: number; heights?: Record<string, number>; order?: string[] }
const KEY = 'hlm-layout-v2';

function read(): Saved { try { return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Saved; } catch { return {}; } }
function write(saved: Saved): void { try { window.localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ } }

export interface LayoutPane { id: string; root: HTMLElement; /** Initial height in px for fixed-height panes; the flexible pane has none. */ height?: number; min?: number; head?: HTMLElement | null }

export class Layout {
  #saved = read();
  #panes: LayoutPane[];
  readonly #splitters: HTMLElement[] = [];
  /** The vertical splitters: between the flow column and the map, and between the map and the book. */
  #flowSplit: HTMLElement | null = null;
  #sideSplit: HTMLElement;
  /** The heights `#fit` last gave the panes under the map: a pane still at one of them was not resized by hand, and keeps its own height when saved. */
  #fitted = new Map<string, number>();
  /** The arrangement the page starts with when nothing is saved (the Default layout). */
  readonly #defaults: PaneArrangement;

  constructor(private main: HTMLElement, private chart: HTMLElement, private side: HTMLElement, panes: LayoutPane[], private flow: HTMLElement | null = null) {
    this.#panes = panes;
    this.#defaults = { order: panes.map(p => p.id), heights: Object.fromEntries(panes.flatMap(p => p.height !== undefined ? [[p.id, p.height]] : [])), sideW: 420, flowW: 300 };
    // Restore pane order and heights: the saved order, and a pane it does not know (one added since) after the others, so a new pane does
    // not undo a person's order.
    this.#panes = arrangeOrder(this.#saved.order ?? [], panes.map(p => ({ id: p.id, fixed: p.height !== undefined }))).map(id => panes.find(p => p.id === id)!);
    for (const pane of this.#panes) {
      if (pane.height !== undefined) this.#setHeight(pane, this.#saved.heights?.[pane.id] ?? pane.height);
      this.chart.append(pane.root);
      if (pane.head) this.#grip(pane);
    }
    // Column splitter between the chart and side columns.
    const column = document.createElement('div'); column.className = 'splitter v'; setTip(column, t('Drag to resize'));
    this.main.insertBefore(column, this.side);
    this.#sideSplit = column;
    this.#setSideWidth(this.#saved.sideW ?? 420);
    this.#drag(column, (dx) => this.#setSideWidth(startSide - dx), () => { startSide = this.#sideWidth(); }, () => this.#persist());
    let startSide = this.#sideWidth();
    if (this.flow) {
      const left = document.createElement('div'); left.className = 'splitter v'; setTip(left, t('Drag to resize'));
      this.main.insertBefore(left, this.chart);
      this.#flowSplit = left;
      this.#setFlowWidth(this.#saved.flowW ?? 300);
      this.#drag(left, (dx) => this.#setFlowWidth(startFlow + dx), () => { startFlow = this.#flowWidth(); }, () => this.#persist());
      var startFlow = this.#flowWidth();
    }
    this.rebuild();
    window.addEventListener('resize', () => this.#fit());
  }

  #flowWidth(): number { return parseFloat(getComputedStyle(this.main).getPropertyValue('--flow-w')) || 300; }
  #setFlowWidth(w: number): void { this.main.style.setProperty('--flow-w', `${Math.round(Math.max(200, Math.min(window.innerWidth * 0.5, w)))}px`); }
  #sideWidth(): number { return parseFloat(getComputedStyle(this.main).getPropertyValue('--side-w')) || 420; }
  #setSideWidth(w: number): void { this.main.style.setProperty('--side-w', `${Math.round(Math.max(260, Math.min(window.innerWidth * 0.7, w)))}px`); }
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
    write({ sideW: this.#sideWidth(), flowW: this.flow ? this.#flowWidth() : this.#saved.flowW, heights: { ...this.#saved.heights, ...heights }, order: this.#panes.map(p => p.id) });
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
   * Show or hide the two side columns (the flow column left of the map and the book right of it) and give the grid the columns that are left.
   * Hiding is instant: nothing is rebuilt, a column and its splitter just stop being laid out.
   */
  columns(show: { flow: boolean; book: boolean }): void {
    const flow = show.flow && this.flow !== null, book = show.book;
    if (this.flow) this.flow.hidden = !flow;
    if (this.#flowSplit) this.#flowSplit.hidden = !flow;
    this.side.hidden = !book; this.#sideSplit.hidden = !book;
    const tracks: string[] = [];
    if (flow) tracks.push('var(--flow-w)', '6px');
    tracks.push('minmax(0,1fr)');
    if (book) tracks.push('6px', 'var(--side-w)');
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
  defaults(): PaneArrangement { return { ...this.#defaults, order: [...this.#defaults.order], heights: { ...this.#defaults.heights } }; }

  /** The panes as they are now: order, heights (a hidden pane's as it will come back), and the column widths. */
  arrangement(): PaneArrangement {
    const heights: Record<string, number> = {};
    for (const p of this.#panes) if (p.height !== undefined) heights[p.id] = Math.round(!p.root.hidden ? this.#height(p) : this.#saved.heights?.[p.id] ?? p.height);
    return { order: this.#panes.map(p => p.id), heights, sideW: Math.round(this.#sideWidth()), flowW: Math.round(this.flow ? this.#flowWidth() : this.#saved.flowW ?? 300) };
  }

  /**
   * Arrange the panes as `a` says (a saved layout): their order (panes it does not know after the others), every fixed pane's height,
   * hidden ones too so they come back at it, and the column widths; then keep it as the page's own. Not on a phone, which arranges by tab.
   */
  apply(a: PaneArrangement): void {
    if (isPhone()) return;
    const known = this.#defaults.order.map(id => ({ id, fixed: this.#defaults.heights[id] !== undefined }));
    const ids = arrangeOrder(a.order, known);
    this.#panes = ids.map(id => this.#panes.find(p => p.id === id)!);
    const heights: Record<string, number> = { ...this.#saved.heights };
    for (const p of this.#panes) if (p.height !== undefined) { const h = a.heights[p.id] ?? heights[p.id] ?? p.height; this.#setHeight(p, h); heights[p.id] = Math.round(Math.max(p.min ?? 70, h)); }
    this.#setSideWidth(a.sideW);
    if (this.flow) this.#setFlowWidth(a.flowW);
    this.#reattach();
    // What was asked for, not what is measured: a pane hidden now has no height to measure.
    write({ sideW: this.#sideWidth(), flowW: this.flow ? this.#flowWidth() : a.flowW, heights, order: ids });
    this.#saved = read();
  }

  /** Set a fixed-height pane's height (its content changed size) and remember it. */
  setPaneHeight(id: string, h: number): void {
    const pane = this.#panes.find(candidate => candidate.id === id);
    if (!pane || pane.height === undefined) return;
    this.#setHeight(pane, h); this.#persist();
  }

  /** Header grip that reorders fixed panes by dragging over their neighbours. */
  #grip(pane: LayoutPane): void {
    const grip = document.createElement('span'); grip.className = 'grip'; setTip(grip, t('Drag to move this pane')); grip.textContent = '⠿';
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
