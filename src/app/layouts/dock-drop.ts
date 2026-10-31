import type { Side, SidePaneId } from './dock-model.ts';

/**
 * Where a pane being dragged by its header would land: the pure half of the drag (`layout.ts` measures the page into a `DropScene`, follows the
 * pointer, draws the mark `dropTarget` answers with and moves the pane when it is let go).
 *
 * A side pane (the flow column, the book) goes to either side of the map, before any pane open in that column; where the column has nothing
 * open it is the strip along the window's edge that is marked, so that a column that is not there can still be dropped on. A pane under the
 * map goes between the panes under the map, and nowhere else: its time axis is the map's, so a column beside the map is no place for it, and
 * neither is the place above the map.
 */
export interface Box { x: number; y: number; w: number; h: number }
export interface SceneColumn { box: Box; /** Whether the column is laid out (has a pane open): else it is the strip where one would be put. */ open: boolean; panes: { id: SidePaneId; box: Box }[] }
export interface DropScene {
  /** The page's working area: the columns and the map's column, between the bars. A pointer outside it drops nothing. */
  main: Box;
  /** How wide the mark is where a column is not laid out yet. */
  edge: number;
  columns: Record<Side, SceneColumn>;
  /** The map's column: its open panes top to bottom, the map among them (not `fixed`: nothing moves it). */
  strip: { box: Box; panes: { id: string; box: Box; fixed: boolean }[] };
}
export type Dragged = { kind: 'side'; id: SidePaneId } | { kind: 'strip'; id: string };
/** What the mark is: a bar between two panes, or a whole column (where the pane would stand alone). */
export type DropTarget =
  | { kind: 'side'; side: Side; beforeId: SidePaneId | null; box: Box; area: boolean }
  | { kind: 'strip'; beforeId: string | null; box: Box; area: false };

const inside = (b: Box, x: number, y: number): boolean => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
const BAR = 4;
const bar = (box: Box, y: number): Box => ({ x: box.x, y: Math.round(y - BAR / 2), w: box.w, h: BAR });

export function dropTarget(scene: DropScene, drag: Dragged, x: number, y: number): DropTarget | null {
  if (!inside(scene.main, x, y)) return null;
  if (drag.kind === 'strip') {
    if (!inside(scene.strip.box, x, y)) return null;
    const fixed = scene.strip.panes.filter(p => p.fixed && p.id !== drag.id);
    const before = fixed.find(p => y < p.box.y + p.box.h / 2) ?? null;
    const last = scene.strip.panes[scene.strip.panes.length - 1];
    const line = before ? before.box.y : last ? last.box.y + last.box.h : scene.strip.box.y + scene.strip.box.h;
    return { kind: 'strip', beforeId: before?.id ?? null, box: bar(scene.strip.box, line), area: false };
  }
  const { left, right } = scene.columns;
  const side: Side = left.open && inside(left.box, x, y) ? 'left' : right.open && inside(right.box, x, y) ? 'right' : x < scene.main.x + scene.main.w / 2 ? 'left' : 'right';
  const column = scene.columns[side], others = column.panes.filter(p => p.id !== drag.id);
  if (!column.open || others.length === 0) {
    const edge = Math.min(scene.edge, Math.round(scene.main.w / 3));
    const box = column.open ? column.box : { x: side === 'left' ? scene.main.x : scene.main.x + scene.main.w - edge, y: scene.main.y, w: edge, h: scene.main.h };
    return { kind: 'side', side, beforeId: null, box, area: true };
  }
  const before = others.find(p => y < p.box.y + p.box.h / 2) ?? null, last = others[others.length - 1]!;
  return { kind: 'side', side, beforeId: before?.id ?? null, box: bar(column.box, before ? before.box.y : last.box.y + last.box.h), area: false };
}
