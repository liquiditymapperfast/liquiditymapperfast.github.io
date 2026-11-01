import type { AppState } from '../store.ts';
import type { PaneArrangement } from './layouts.ts';
import { PANE_SHOW_KEY, SIDE_PANES, STRIP_PANES, legacyPlan, readPlan, type DockPlan } from './dock-model.ts';

/**
 * Which layout the screen is showing, and whether it has been changed since: a layout is what the eye takes from the screen, so it is
 * compared as that: which panes are open, which side the side panes stand on and how wide their columns are, and the order and heights of the
 * open panes under the map. A pane that is closed has no place on the screen, so where it would stand does not count, and the Scripts
 * pane, which a layout does not decide (it shows where a script draws in a row), is left out.
 */
export interface Shot { open: Record<string, boolean>; dock: DockPlan; strip: { id: string; height: number }[] }
/** The layout last applied or saved: what it was called, where it came from, and how the screen looked right after. */
export interface Active { kind: 'preset' | 'saved'; id: string; shot: Shot }

/** How far a stacked pane's share of its column may differ and still be the same layout (the splitter moves a pixel or two by itself). */
const SHARE_TOLERANCE = 0.03;
const JUDGED = [...SIDE_PANES, ...STRIP_PANES.map(p => p.id).filter(id => id !== 'script')] as readonly string[];

export function shotOf(a: PaneArrangement, show: AppState['show']): Shot {
  const open: Record<string, boolean> = {};
  for (const id of JUDGED) open[id] = show[PANE_SHOW_KEY[id]!] === true;
  const strip = a.order.filter(id => id !== 'heat' && open[id]).map(id => ({ id, height: a.heights[id] ?? 0 }));
  return { open, dock: a.dock ?? legacyPlan(a.flowW, a.sideW), strip };
}

/** The same layout: the same panes open, in the same places, the sizes within a few pixels. */
export function sameShot(a: Shot, b: Shot, tolerance = 8): boolean {
  if (!JUDGED.every(id => a.open[id] === b.open[id])) return false;
  // Where a column stands matters only for the panes that are open in it.
  const openOf = (s: Shot, side: 'left' | 'right'): string[] => s.dock[side].filter(id => s.open[id]);
  if (openOf(a, 'left').join() !== openOf(b, 'left').join() || openOf(a, 'right').join() !== openOf(b, 'right').join()) return false;
  // A column that follows the window is not the same as one that was dragged to a width, even if it happens to be that wide here.
  const near = (x: number | null, y: number | null): boolean => x === null || y === null ? x === y : Math.abs(x - y) <= tolerance;
  if (openOf(a, 'left').length && !near(a.dock.leftW, b.dock.leftW)) return false;
  if (openOf(a, 'right').length && !near(a.dock.rightW, b.dock.rightW)) return false;
  // Panes stacked in a column share its height by their weights: the splitter between them dragged is a change too (the lists are the same here).
  const shares = (s: Shot, side: 'left' | 'right'): number[] => {
    const ids = openOf(s, side), weight = (id: string): number => s.dock.weights[id as keyof DockPlan['weights']] ?? 1, sum = ids.reduce((t, id) => t + weight(id), 0);
    return ids.map(id => weight(id) / sum);
  };
  for (const side of ['left', 'right'] as const) {
    const x = shares(a, side), y = shares(b, side);
    if (x.length > 1 && x.some((v, i) => Math.abs(v - y[i]!) > SHARE_TOLERANCE)) return false;
  }
  if (a.strip.length !== b.strip.length) return false;
  return a.strip.every((p, i) => p.id === b.strip[i]!.id && Math.abs(p.height - b.strip[i]!.height) <= tolerance);
}

/** A shot from storage, or null. */
export function readShot(raw: unknown): Shot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, dock = readPlan(r.dock);
  if (!dock || !r.open || typeof r.open !== 'object' || !Array.isArray(r.strip)) return null;
  const open: Record<string, boolean> = {};
  for (const id of JUDGED) open[id] = (r.open as Record<string, unknown>)[id] === true;
  const strip = r.strip.flatMap((p): { id: string; height: number }[] => p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string' && Number.isFinite((p as { height?: unknown }).height) ? [{ id: (p as { id: string }).id, height: (p as { height: number }).height }] : []).slice(0, 12);
  return { open, dock, strip };
}
export function readActive(raw: unknown): Active | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, shot = readShot(r.shot);
  return shot && (r.kind === 'preset' || r.kind === 'saved') && typeof r.id === 'string' && r.id.length <= 60 ? { kind: r.kind, id: r.id, shot } : null;
}
