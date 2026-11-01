import { union, type Rect } from './place.ts';
import type { TargetId } from './steps.ts';

/**
 * What each name in a step points at, as selectors of the page, the first that is on the screen standing for it (a closed side pane is its edge
 * tab). Resolved when a step is shown, not kept: the bar is rebuilt when the window changes shape, and a pane can come and go.
 */
export const SELECTORS: Readonly<Record<TargetId, readonly string[]>> = {
  map: ['.pane.heat'],
  market: ['.deck-market'],
  time: ['.deck-time'],
  panels: ['.deck-panels'],
  chart: ['.deck-chart'],
  flow: ['.pane.cvd', '.edge-tab[data-pane="cvd"]'],
  book: ['.pane.ladder', '.edge-tab[data-pane="book"]'],
  layouts: ['.map-layout'],
  tour: ['.tour-btn'],
  guide: ['.guide-btn'],
  coin: ['.coin-btn'],
  settings: ['.more-btn'],
  tabs: ['nav.dock'],
  mapTab: ['.dock-tab[data-tab="map"]'],
};

const shown = (node: HTMLElement): boolean => { if (node.hidden) return false; const r = node.getBoundingClientRect(); return r.width > 1 && r.height > 1; };

/** The element a name stands for on the screen now, or null. */
export function find(id: TargetId, root: ParentNode = document): HTMLElement | null {
  for (const selector of SELECTORS[id]) for (const node of root.querySelectorAll<HTMLElement>(selector)) if (shown(node)) return node;
  return null;
}

/** The elements of several names that are on the screen. */
export const findAll = (ids: readonly TargetId[], root: ParentNode = document): HTMLElement[] => ids.flatMap(id => { const node = find(id, root); return node ? [node] : []; });

/** Where what a step points at is, as one rectangle (null when none of it is on the screen). */
export function rectOf(ids: readonly TargetId[], root: ParentNode = document): Rect | null {
  return union(findAll(ids, root).map(node => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }));
}
