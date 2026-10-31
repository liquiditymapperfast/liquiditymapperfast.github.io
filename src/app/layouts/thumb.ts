import { defaultColumns, type PaneArrangement } from './layouts.ts';
import { MIN_COLUMN_W, PANE_SHOW_KEY, defaultPlan, fitColumns, legacyPlan, type Side, type SidePaneId } from './dock-model.ts';
import type { AppState } from '../store.ts';
import type { PresetEnv } from './presets.ts';

/**
 * A layout as a small picture: boxes in a unit square, for a card in the layouts panel (`gallery.ts` draws them). The same arithmetic the page
 * lays itself out with, taken down to a sketch: the columns as wide as they would be in a window `env.width` wide, the map with the panes under it
 * as tall as they would be in a column `env.height` tall (the map keeps at least `MAP_MIN` of it), the panes in a column sharing its height by their weights.
 */
export interface ThumbBox { kind: 'map' | 'cvd' | 'book' | 'strip'; id: string; x: number; y: number; w: number; h: number }

/** The gap between boxes, and the least of the column the map keeps. */
export const GAP = 0.018, MAP_MIN = 0.3;

export function thumbBoxes(a: PaneArrangement, show: Readonly<Partial<AppState['show']>>, env: PresetEnv): ThumbBox[] {
  // The Scripts pane is not a layout's to show: it appears where a script draws in a row, so the sketch leaves it out.
  const open = (id: string): boolean => { const key = PANE_SHOW_KEY[id]; return id !== 'script' && key !== undefined && show[key] === true; };
  const plan = a.dock ?? (a.flowW > 0 ? legacyPlan(a.flowW, a.sideW) : defaultPlan());
  const wide = defaultColumns(env.width);
  const openIn = (side: Side): SidePaneId[] => plan[side].filter(open);
  const asked = (side: Side): number => {
    const ids = openIn(side), own = side === 'left' ? plan.leftW : plan.rightW;
    return ids.length === 0 ? 0 : own ?? (ids[0] === 'book' ? wide.sideW : wide.flowW);
  };
  const both = openIn('left').length > 0 && openIn('right').length > 0;
  const [lw, rw] = both ? fitColumns(asked('left'), asked('right'), env.width, MIN_COLUMN_W.cvd, MIN_COLUMN_W.book) : [asked('left'), asked('right')];
  const cap = (px: number): number => Math.min(0.4, px / env.width);
  const left = cap(lw), right = cap(rw);
  const boxes: ThumbBox[] = [];
  const column = (side: Side, x: number, w: number): void => {
    const ids = openIn(side);
    if (!ids.length) return;
    const weights = ids.map(id => plan.weights[id] ?? 1), total = weights.reduce((s, v) => s + v, 0), room = 1 - GAP * (ids.length - 1);
    let y = 0;
    ids.forEach((id, i) => { const h = room * weights[i]! / total; boxes.push({ kind: id, id, x, y, w, h }); y += h + GAP; });
  };
  const gapL = left > 0 ? GAP : 0, gapR = right > 0 ? GAP : 0;
  const cx = left + gapL, cw = 1 - left - gapL - right - gapR;
  column('left', 0, left); column('right', 1 - right, right);
  // The panes under the map in their order, each as tall as its height is of the column; together at most what leaves the map its share.
  const strip = a.order.filter(id => id !== 'heat' && open(id)).map(id => ({ id, share: (a.heights[id] ?? 90) / env.height }));
  const most = 1 - MAP_MIN - GAP * strip.length, sum = strip.reduce((s, p) => s + p.share, 0), f = sum > most && sum > 0 ? most / sum : 1;
  const under = strip.reduce((s, p) => s + p.share * f + GAP, 0);
  boxes.push({ kind: 'map', id: 'heat', x: cx, y: 0, w: cw, h: Math.max(MAP_MIN, 1 - under) });
  let y = Math.max(MAP_MIN, 1 - under) + GAP;
  for (const p of strip) { const h = p.share * f; boxes.push({ kind: 'strip', id: p.id, x: cx, y, w: cw, h }); y += h + GAP; }
  return boxes;
}
