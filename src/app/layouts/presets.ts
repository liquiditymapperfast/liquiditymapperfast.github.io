import { defaultShow, type AppState } from '../store.ts';
import { t } from '../i18n.ts';
import { defaultColumns, type PaneArrangement } from './layouts.ts';
import { PANE_SHOW_KEY, STRIP_PANES, stripSize, type DockPlan, type StripId } from './dock-model.ts';

/**
 * The ready-made layouts. Each is one way of working, not a place to put panes: which panes are open, the order of those under the map and the
 * share of the column they take, how wide the flow column and the book are, and the few chart switches that way of working is about (the
 * footprint, for reading the order flow). Nothing else: a ready-made layout never touches the heatmap's colours, the timeframe, the venues or any
 * other setting, so trying one after another changes what is on the screen and nothing about how it is drawn.
 *
 * They are made for the window they are applied in (`buildPreset`): the heights of the panes under the map are shares of the map's column, and
 * the widths of the columns shares of the window, so that the same layout fits a laptop and a large screen. The flow column is left of the map and
 * the book right of it in all of them; "Swap the two sides" turns any of them over.
 */
export type PresetId = 'default' | 'map' | 'book' | 'flow' | 'positioning' | 'everything';

export interface PresetDef {
  id: PresetId;
  name: () => string;
  /** What it is for, in a sentence: the flow of thought from what is on the screen to what it tells. */
  blurb: () => string;
  /** Which side panes are open; the flow column's follows the window where it is left out (as it does on a first visit). */
  cvd?: boolean; book: boolean;
  /** The panes under the map, top to bottom, each with the weight of its height among them; `bars` keeps the height its rows need. */
  strip: readonly (readonly [StripId, number])[];
  /** The share of the map's column the panes under the map take together. */
  stripShare: number;
  /** The width of the flow column and of the book as a share of the window (they follow the window, as the stylesheet sizes them, where it is left out). */
  leftShare?: number; rightShare?: number;
  /** Chart switches this way of working is about. */
  overlays?: Partial<AppState['show']>;
}

export const PRESETS: readonly PresetDef[] = [
  {
    id: 'default', name: () => t('Default'), blurb: () => t('The map and the order book, with the flow column on a wide screen: how the page first opens.'),
    book: true, strip: [], stripShare: 0,
  },
  {
    id: 'map', name: () => t('Map only'), blurb: () => t('Just the map, as large as the window allows.'),
    cvd: false, book: false, strip: [], stripShare: 0,
  },
  {
    id: 'book', name: () => t('Order book'), blurb: () => t('A wide order book beside the map, with Depth and the Liquidity Tracker under it: where liquidity rests, and whether it is pulled.'),
    cvd: false, book: true, strip: [['depth', 1], ['lt', 1]], stripShare: 0.34, rightShare: 0.27,
  },
  {
    id: 'flow', name: () => t('Order flow'), blurb: () => t('A wide flow column, Delta and Bar stats under the map, and the footprint on: who is buying and selling at market, and how hard.'),
    cvd: true, book: false, strip: [['delta', 1.2], ['bars', 0]], stripShare: 0.36, leftShare: 0.24, overlays: { footprint: true },
  },
  {
    id: 'positioning', name: () => t('Positioning'), blurb: () => t('Open interest, long/short and Delta under a wide map: who holds what, and how it changes.'),
    cvd: false, book: false, strip: [['oi', 1.3], ['ls', 1], ['delta', 1.1]], stripShare: 0.5,
  },
  {
    id: 'everything', name: () => t('Everything'), blurb: () => t('Every panel at once, for a large screen.'),
    cvd: true, book: true, strip: [['bars', 0], ['depth', 1], ['oi', 1], ['delta', 1], ['ls', 0.8], ['lt', 0.9], ['funding', 0.9]], stripShare: 0.62,
  },
];

/**
 * The room a layout is made for: the window's width, and the height of the map's column (the map and the panes under it share it). `held` are the
 * panes under the map that stay open whatever the layout does (the Scripts pane, which is the person's own): they take room of that column too.
 */
export interface PresetEnv { width: number; height: number; held?: readonly StripId[] }
export interface BuiltPreset { arrangement: PaneArrangement; show: Partial<AppState['show']> }

/** The tallest a pane under the map is made by a share of the column: past it a pane is a wall of empty chart. */
const TALLEST_PX = 360;
/** What a pane that keeps the height its rows need (the Bar stats table) is counted as when the rest of the share is divided. */
const OWN_HEIGHT_PX = 90;
/** The least the map is left (its own CSS minimum) and what a splitter takes: a layout opens as many of its panes under the map as fit under those. */
const MAP_FLOOR_PX = 240, SPLITTER_PX = 5;

export function buildPreset(def: PresetDef, env: PresetEnv): BuiltPreset {
  // A layout made for a large screen opens as many of its panes as the window has room for, in the order it lists them: past that the last of them would be pushed off the screen.
  const held = (env.held ?? []).filter(id => !def.strip.some(([own]) => own === id));
  const room = (list: readonly StripId[]): number => [...held, ...list].reduce((sum, id) => sum + stripSize(id).min + SPLITTER_PX, MAP_FLOOR_PX);
  const kept = def.strip.map(([id]) => id);
  while (kept.length && room(kept) > env.height) kept.pop();
  const strip = def.strip.filter(([id]) => kept.includes(id));
  const ids = kept;
  // Which panes are open: every pane the page can open, those under the map by whether the layout lists them. The Scripts pane is the person's own (it shows only where a script
  // draws in a row) and is left as it is.
  const show: Partial<AppState['show']> = { cvd: def.cvd ?? defaultShow(env.width).cvd, book: def.book };
  for (const pane of STRIP_PANES) if (pane.id !== 'script') show[PANE_SHOW_KEY[pane.id]!] = ids.includes(pane.id);
  Object.assign(show, def.overlays);
  const weights = strip.filter(([, w]) => w > 0), total = weights.reduce((sum, [, w]) => sum + w, 0);
  const share = Math.max(0, def.stripShare * env.height - (strip.length - weights.length) * OWN_HEIGHT_PX);
  const heights: Record<string, number> = {};
  for (const pane of STRIP_PANES) heights[pane.id] = pane.height;
  for (const [id, w] of weights) heights[id] = Math.round(Math.max(stripSize(id).min, Math.min(TALLEST_PX, share * w / total)));
  // The Bar stats table is as tall as its rows need (the page sizes it when they change): a layout never gives it a height of its own.
  delete heights.bars;
  const rest = STRIP_PANES.map(p => p.id).filter(id => !ids.includes(id));
  const wide = defaultColumns(env.width);
  const columnShare = (s: number | undefined, min: number, max: number): number | null => s === undefined ? null : Math.round(Math.max(min, Math.min(max, env.width * s)));
  const dock: DockPlan = { left: ['cvd'], right: ['book'], leftW: columnShare(def.leftShare, 260, 520), rightW: columnShare(def.rightShare, 350, 620), weights: {} };
  const arrangement: PaneArrangement = { order: ['heat', ...ids, ...rest], heights, flowW: dock.leftW ?? wide.flowW, sideW: dock.rightW ?? wide.sideW, dock };
  return { arrangement, show };
}
