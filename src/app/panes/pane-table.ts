import { mixHex, type Palette } from '../theme.ts';
import type { Pt } from '../touch.ts';

/**
 * The table a pane under the map draws on itself: several things of one kind read at one moment (the Depth pane's bands, the venues of the Funding, Open
 * Interest and Long/Short panes), while its chart shows their history or their sum. Beside the plot where the columns right of it leave room, the last columns
 * going first; else over the plot's left end on a plate while the pointer (or a pinned finger) is on the pane, so it never covers the newest candles and leaves the
 * chart clear at rest. In a short pane the rows close up (15 px down to 12) and the titles, then the foot, are left out; where even a row each does not fit,
 * there is no table.
 */

/** One cell: its words and, where it has one, its colour (else the text colour). */
export interface TableCell { text: string; color?: string | undefined }

export interface TableSpec {
  /** The column titles, the first over the rows' names (usually empty). */
  heads: readonly string[];
  /** A row a thing, a cell a column, the first cell its name. */
  rows: readonly (readonly TableCell[])[];
  /** What is said under the rows (the time read, the units). */
  foot: string;
  /** The fewest columns kept beside the plot: fewer would not say what the table is for, and it goes on a plate. */
  minCols: number;
  /** The row lit as the one chosen; -1 for none. */
  focus: number;
}

/** The pane's room, in plot coordinates: its width and height, the plot's width, the price axis's and whether a pointer (or a finger) is on the pane. */
export interface TableRoom { w: number; h: number; plotW: number; axisW: number; pointing: boolean }

/** Where a table goes: the row height, what of it fits, its left edge and width, whether it is on a plate, its top, its first row and each column's right edge. */
export interface TablePlace { rowH: number; titles: boolean; foot: boolean; cols: number; left: number; plate: boolean; width: number; y0: number; first: number; rights: number[] }

const GAP = 7, PAD = 5;
const ROW_HEIGHTS = [15, 14, 13, 12] as const;

/** A figure of a table in a side's colour, a little towards the text colour so that it reads at this size. */
export const tableInk = (side: string, p: Pick<Palette, 'text'>): string => mixHex(side, p.text, 0.2);

/** Where a table goes in `room`, or null where it does not fit. `measure` is the width of a text in the pane's font. */
export function placeTable(measure: (text: string) => number, room: TableRoom, spec: Pick<TableSpec, 'heads' | 'rows' | 'minCols'>): TablePlace | null {
  const k = spec.rows.length, n = spec.heads.length;
  let rowH = 0, titles = true, foot = true;
  fit: for (const [withTitles, withFoot] of [[true, true], [false, true], [false, false]] as const) {
    for (const h of ROW_HEIGHTS) if ((k + (withTitles ? 1 : 0) + (withFoot ? 1 : 0)) * h + 4 <= room.h) { rowH = h; titles = withTitles; foot = withFoot; break fit; }
  }
  if (!rowH) return null;
  const widths = spec.heads.map((head, c) => Math.max(measure(head), ...spec.rows.map(row => measure(row[c]?.text ?? ''))));
  const width = (cols: number): number => widths.slice(0, cols).reduce((a, b) => a + b, 0) + GAP * (cols - 1) + PAD * 2;
  const free = room.w - room.axisW - room.plotW;
  let cols = n, left = room.plotW + 4, plate = false;
  while (cols >= spec.minCols && width(cols) > free - 4) cols--;
  if (cols < spec.minCols) { cols = n; left = 6; plate = true; if (!room.pointing || width(n) > room.plotW * 0.6) return null; }
  const height = (k + (titles ? 1 : 0) + (foot ? 1 : 0)) * rowH, y0 = Math.round(room.h / 2 - height / 2), first = y0 + (titles ? rowH : 0);
  const rights: number[] = [];
  for (let c = 0, x = left + PAD; c < cols; c++) { x += widths[c]!; rights.push(x); x += GAP; }
  return { rowH, titles, foot, cols, left, plate, width: width(cols), y0, first, rights };
}

/** Draw a placed table: the plate under it if it has one, the titles, a row each (the chosen one lit, the one `hover` less so) and the foot. */
export function paintTable(ctx: CanvasRenderingContext2D, p: Pick<Palette, 'panel' | 'line' | 'text' | 'muted'>, at: TablePlace, spec: TableSpec, hover: number): void {
  const k = spec.rows.length, height = (k + (at.titles ? 1 : 0) + (at.foot ? 1 : 0)) * at.rowH;
  if (at.plate) { ctx.fillStyle = p.panel; ctx.globalAlpha = 0.9; ctx.fillRect(at.left, at.y0 - 2, at.width, height + 4); ctx.globalAlpha = 1; ctx.strokeStyle = p.line; ctx.strokeRect(at.left + 0.5, at.y0 - 1.5, at.width - 1, height + 3); }
  ctx.textAlign = 'right'; ctx.fillStyle = p.muted;
  if (at.titles) for (let c = 1; c < at.cols; c++) ctx.fillText(spec.heads[c]!, at.rights[c]!, at.y0 + at.rowH / 2);
  for (let j = 0; j < k; j++) {
    const y = at.first + j * at.rowH, row = spec.rows[j]!, mid = y + at.rowH / 2;
    if (j === spec.focus || j === hover) { ctx.fillStyle = p.text; ctx.globalAlpha = j === spec.focus ? 0.1 : 0.05; ctx.fillRect(at.left + 2, y, at.width - 4, at.rowH); ctx.globalAlpha = 1; }
    ctx.textAlign = 'left'; ctx.fillStyle = j === spec.focus ? p.text : p.muted; ctx.fillText(row[0]!.text, at.left + PAD, mid);
    ctx.textAlign = 'right';
    for (let c = 1; c < at.cols; c++) { ctx.fillStyle = row[c]!.color ?? p.text; ctx.fillText(row[c]!.text, at.rights[c]!, mid); }
  }
  ctx.textAlign = 'left'; ctx.fillStyle = p.muted;
  if (at.foot && spec.foot) ctx.fillText(spec.foot, at.left + PAD, at.first + k * at.rowH + at.rowH / 2);
}

/** What a table needs of its pane. */
export interface TableHost { canvas: HTMLCanvasElement; left: () => number; rangeGesture: () => boolean; invalidate: () => void }

/**
 * A pane's table and the pointer over it. It owns the pointer over it (the time is not read there, so that it can be read); with `onRow`, a row under
 * the pointer is lit and takes a click or a tap.
 */
export class PaneTable {
  #at: TablePlace | null = null;
  #rows = 0;
  #hover = -1;
  /** When a finger last chose a row: the click the browser sends after that tap is the same choice, not a second one. */
  #tappedAt = -Infinity;

  constructor(private readonly host: TableHost, private readonly onRow: ((row: number) => void) | null = null) {
    if (!onRow) return;
    host.canvas.addEventListener('click', e => {
      if (host.rangeGesture() || (e as PointerEvent).pointerType === 'touch' || performance.now() - this.#tappedAt < 800) return;
      const r = host.canvas.getBoundingClientRect(), row = this.#rowAt(e.clientX - r.left - host.left(), e.clientY - r.top);
      if (row >= 0) onRow(row);
    });
    host.canvas.addEventListener('pointerleave', () => this.#light(-1));
  }

  /** No table this frame (a pane calls it before it draws, so that one it does not draw takes no pointer). */
  clear(): void { this.#at = null; }

  /** Draw it where it fits; where it went, or null where it does not. */
  draw(ctx: CanvasRenderingContext2D, p: Pick<Palette, 'panel' | 'line' | 'text' | 'muted'>, room: TableRoom, spec: TableSpec): TablePlace | null {
    const at = placeTable(text => ctx.measureText(text).width, room, spec);
    this.#at = at; this.#rows = spec.rows.length;
    if (at) paintTable(ctx, p, at, spec, this.#hover);
    return at;
  }

  /** Whether the pointer at `x` (plot coordinates) is over the table. */
  owns(x: number, pointer: { y: number } | null): boolean {
    const at = this.#at;
    if (!at || !pointer) { this.#light(-1); return false; }
    const y = pointer.y - this.host.canvas.getBoundingClientRect().top;
    if (this.onRow) { const row = this.#rowAt(x, y); this.#light(row); if (row >= 0) this.host.canvas.style.cursor = 'pointer'; }
    return x >= at.left && x <= at.left + at.width && y >= at.first - at.rowH && y <= at.first + (this.#rows + 1) * at.rowH;
  }

  /** Whether a finger's tap at `p` (plot coordinates) chose a row. */
  tap(p: Pt): boolean {
    if (!this.onRow) return false;
    const row = this.#rowAt(p.x, p.y);
    if (row < 0) return false;
    this.#tappedAt = performance.now(); this.onRow(row);
    return true;
  }

  #light(row: number): void { if (row !== this.#hover) { this.#hover = row; this.host.invalidate(); } }
  #rowAt(x: number, y: number): number {
    const at = this.#at;
    if (!at || x < at.left || x > at.left + at.width) return -1;
    const row = Math.floor((y - at.first) / at.rowH);
    return row >= 0 && row < this.#rows ? row : -1;
  }
}
