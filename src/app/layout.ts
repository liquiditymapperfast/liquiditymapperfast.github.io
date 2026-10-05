/** Resizable, reorderable layout: splitters between panes, persisted in localStorage. */
interface Saved { sideW?: number; heights?: Record<string, number>; order?: string[] }
const KEY = 'hlm-layout-v2';

function read(): Saved { try { return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Saved; } catch { return {}; } }
function write(saved: Saved): void { try { window.localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ } }

export interface LayoutPane { id: string; root: HTMLElement; /** Initial height in px for fixed-height panes; the flexible pane has none. */ height?: number; min?: number; head?: HTMLElement | null }

export class Layout {
  #saved = read();
  #panes: LayoutPane[];
  readonly #splitters: HTMLElement[] = [];

  constructor(private main: HTMLElement, private chart: HTMLElement, private side: HTMLElement, panes: LayoutPane[]) {
    this.#panes = panes;
    // Restore pane order and heights.
    const order = this.#saved.order?.filter(id => panes.some(p => p.id === id)) ?? [];
    if (order.length === panes.length) this.#panes = order.map(id => panes.find(p => p.id === id)!);
    for (const pane of this.#panes) {
      if (pane.height !== undefined) this.#setHeight(pane, this.#saved.heights?.[pane.id] ?? pane.height);
      this.chart.append(pane.root);
      if (pane.head) this.#grip(pane);
    }
    // Column splitter between the chart and side columns.
    const column = document.createElement('div'); column.className = 'splitter v'; column.title = 'Drag to resize';
    this.main.insertBefore(column, this.side);
    this.#setSideWidth(this.#saved.sideW ?? 420);
    this.#drag(column, (dx) => this.#setSideWidth(startSide - dx), () => { startSide = this.#sideWidth(); }, () => this.#persist());
    let startSide = this.#sideWidth();
    this.rebuild();
  }

  #sideWidth(): number { return parseFloat(getComputedStyle(this.main).getPropertyValue('--side-w')) || 420; }
  #setSideWidth(w: number): void { this.main.style.setProperty('--side-w', `${Math.round(Math.max(260, Math.min(window.innerWidth * 0.7, w)))}px`); }
  #height(pane: LayoutPane): number { return pane.root.getBoundingClientRect().height; }
  #setHeight(pane: LayoutPane, h: number): void { pane.root.style.flex = `0 0 ${Math.round(Math.max(pane.min ?? 70, h))}px`; }
  #persist(): void {
    const heights: Record<string, number> = {};
    for (const p of this.#panes) if (p.height !== undefined && !p.root.hidden) heights[p.id] = Math.round(this.#height(p));
    write({ sideW: this.#sideWidth(), heights: { ...this.#saved.heights, ...heights }, order: this.#panes.map(p => p.id) });
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

  /** Recreate the horizontal splitters between visible panes (call after panes are shown, hidden or reordered). */
  rebuild(): void {
    for (const s of this.#splitters.splice(0)) s.remove();
    const visible = this.#panes.filter(p => !p.root.hidden);
    visible.forEach((below, i) => {
      if (i === 0) return;
      const above = visible[i - 1]!;
      const bar = document.createElement('div'); bar.className = 'splitter h'; bar.title = 'Drag to resize';
      this.chart.insertBefore(bar, below.root); this.#splitters.push(bar);
      let aboveStart = 0, belowStart = 0;
      this.#drag(bar, null, () => { aboveStart = this.#height(above); belowStart = this.#height(below); }, () => this.#persist(), dy => {
        // The flexible pane absorbs the change; between two fixed panes the boundary moves.
        if (below.height !== undefined) this.#setHeight(below, belowStart - dy);
        if (above.height !== undefined) this.#setHeight(above, aboveStart + dy);
      });
    });
  }

  /** Set a fixed-height pane's height (its content changed size) and remember it. */
  setPaneHeight(id: string, h: number): void {
    const pane = this.#panes.find(candidate => candidate.id === id);
    if (!pane || pane.height === undefined) return;
    this.#setHeight(pane, h); this.#persist();
  }

  /** Header grip that reorders fixed panes by dragging over their neighbours. */
  #grip(pane: LayoutPane): void {
    const grip = document.createElement('span'); grip.className = 'grip'; grip.title = 'Drag to move this pane'; grip.textContent = '⠿';
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
