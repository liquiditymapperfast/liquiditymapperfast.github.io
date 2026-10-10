import { LAYOUT_KEYS, readSettings, type AppState, type Settings } from '../store.ts';

/**
 * Saved layouts: a name for the panes as they are arranged (order, heights, column widths) and the settings of what the chart shows
 * (`LAYOUT_KEYS`). Not the coin, the venues, the theme, the time zone or the sounds, and not two things that belong to a person's own chart:
 * the VWAP anchors (each a moment of one coin) and the Volume profile's zone (a time-zone choice). They are kept in this browser
 * (`hlm-layouts-v1`) and can be written to a file and read back; a file can come from anywhere, so every field goes through `readSettings`.
 */

export const LAYOUTS_KEY = 'hlm-layouts-v1', MAX_LAYOUTS = 20, MAX_NAME = 40, FILE_FORMAT = 'liquiditymapperfast-layouts', MAX_FILE_CHARS = 1_000_000;

/** Where the panes are: their order, the heights of those with a fixed height, and the widths of the flow column and the book (px). */
export interface PaneArrangement { order: string[]; heights: Record<string, number>; sideW: number; flowW: number }
export interface SavedLayout { name: string; savedAt: number; settings: Partial<Settings>; panes: PaneArrangement }

/** A name as it is kept: spaces collapsed and trimmed, at most `MAX_NAME` characters; null when nothing is left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return name ? name : null;
}
const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The settings a layout keeps from a state: `LAYOUT_KEYS`, without the VWAP anchors and the Volume profile's zone. */
export function settingsOf(state: AppState): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of LAYOUT_KEYS) out[key] = state[key];
  const { anchors: _anchors, ...vwap } = state.vwap;
  const { zone: _zone, ...traded } = state.traded;
  return { ...out, vwap: vwap as Settings['vwap'], traded: traded as Settings['traded'] };
}

/** Equal values, whatever order an object's keys are in (a setting read again lists them in its own order). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The fields of `next` that differ from the state (a timeframe set again would reload the chart and jump it to now). */
export function changedSettings(next: Settings, state: AppState): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of LAYOUT_KEYS) if (!same(next[key], state[key])) out[key] = next[key];
  return out as Partial<Settings>;
}

/** What applying a layout's settings sets: each field read as a saved page's is, with this chart's own VWAP anchors and zone kept. */
export function settingsToApply(saved: Partial<Settings>, current: AppState): Settings {
  const settings = readSettings(saved);
  return { ...settings, vwap: { ...settings.vwap, anchors: current.vwap.anchors }, traded: { ...settings.traded, zone: current.traded.zone } };
}

/** A pane arrangement from storage or a file, or null: ids are strings, sizes are finite and within reason. */
export function readArrangement(raw: unknown): PaneArrangement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, size = (v: unknown, lo: number, hi: number): number | null => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null;
  const order = Array.isArray(r.order) ? r.order.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 40).slice(0, 40) : [];
  const heights: Record<string, number> = {};
  if (r.heights && typeof r.heights === 'object') for (const [id, h] of Object.entries(r.heights as Record<string, unknown>).slice(0, 40)) { const v = size(h, 40, 4_000); if (v !== null && id.length <= 40) heights[id] = v; }
  const sideW = size(r.sideW, 200, 4_000), flowW = size(r.flowW, 150, 4_000);
  return sideW === null || flowW === null ? null : { order, heights, sideW, flowW };
}

/** The panes in `saved` order, the ones it does not name (added since) after them in their own order. */
export function mergeOrder(saved: readonly string[], known: readonly string[]): string[] {
  const kept = saved.filter((id, i) => known.includes(id) && saved.indexOf(id) === i);
  return [...kept, ...known.filter(id => !kept.includes(id))];
}

/**
 * The panes' order from a saved one: the panes with a fixed height in the saved order (one it does not name after them), and every flexible
 * pane (the map) at its own place in `known`, since nothing moves it: a file that leaves it out, or a pane renamed since, must not push the map down.
 */
export function arrangeOrder(saved: readonly string[], known: readonly { id: string; fixed: boolean }[]): string[] {
  const fixed = mergeOrder(saved, known.filter(p => p.fixed).map(p => p.id));
  return known.map(p => p.fixed ? fixed.shift()! : p.id);
}

/** The share of the column the map keeps at least, and its smallest height (px), when the panes under it are fitted. */
export const MAP_MIN_SHARE = 0.3, MAP_MIN_PX = 160;

/**
 * The heights of the panes under the map in a column of `avail` px: as wanted while the map keeps `MAP_MIN_SHARE` of the column (at least
 * `mapMin`, its own CSS minimum), else all shrunk in proportion, none below its own minimum. A layout from a taller window, or a window made smaller, would
 * otherwise push the last pane off the screen.
 */
export function fitHeights(want: readonly number[], mins: readonly number[], avail: number, mapMin = MAP_MIN_PX): number[] {
  const room = avail - Math.max(mapMin, avail * MAP_MIN_SHARE), total = want.reduce((a, b) => a + b, 0);
  const f = room > 0 && total > room ? room / total : 1;
  return want.map((h, i) => f < 1 ? Math.max(mins[i] ?? 0, Math.floor(h * f)) : h);
}

/** Layouts from storage or a file: the valid ones, at most `MAX_LAYOUTS`, one per name (the later one wins). */
export function readLayouts(raw: unknown): SavedLayout[] {
  let out: SavedLayout[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>, name = cleanName(r.name), panes = readArrangement(r.panes);
    if (!name || !panes || !r.settings || typeof r.settings !== 'object') continue;
    out = out.filter(l => !sameName(l.name, name));
    // The settings as they will be applied, so nothing else is kept or written back (a file can hold anything).
    out.push({ name, savedAt: typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) ? r.savedAt : 0, settings: settingsOf(readSettings(r.settings as Partial<Settings>) as unknown as AppState), panes });
  }
  return out.slice(-MAX_LAYOUTS);
}

/** Add `layout`, replacing one of the same name in its place; null when the list is full and the name is new. */
export function upsert(list: readonly SavedLayout[], layout: SavedLayout): SavedLayout[] | null {
  const at = list.findIndex(l => sameName(l.name, layout.name));
  if (at >= 0) return list.map((l, i) => i === at ? layout : l);
  return list.length >= MAX_LAYOUTS ? null : [...list, layout];
}

/** The layouts file: a marker, a version and the layouts. */
export function exportFile(list: readonly SavedLayout[]): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, layouts: list }, null, 2);
}

/** The layouts in a file, or why there are none. */
export function importFile(text: string): { layouts: SavedLayout[] } | { error: 'not-layouts' | 'empty' } {
  // Twenty layouts are a few tens of kilobytes; a file far larger is something else, and would fill this browser's storage.
  if (text.length > MAX_FILE_CHARS) return { error: 'not-layouts' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: 'not-layouts' }; }
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== FILE_FORMAT) return { error: 'not-layouts' };
  const layouts = readLayouts((raw as { layouts?: unknown }).layouts);
  return layouts.length ? { layouts } : { error: 'empty' };
}

/** `incoming` added to `list` one by one (a name already there is replaced); those that do not fit are counted, not added. */
export function mergeLayouts(list: readonly SavedLayout[], incoming: readonly SavedLayout[]): { list: SavedLayout[]; added: number; replaced: number; skipped: number } {
  let out = [...list], added = 0, replaced = 0, skipped = 0;
  for (const layout of incoming) {
    const had = out.some(l => sameName(l.name, layout.name)), next = upsert(out, layout);
    if (!next) { skipped++; continue; }
    out = next; if (had) replaced++; else added++;
  }
  return { list: out, added, replaced, skipped };
}

/** The layouts kept in this browser (none when storage is not there or holds something else). */
export function loadLayouts(): SavedLayout[] {
  try { const raw = window.localStorage.getItem(LAYOUTS_KEY); return raw ? readLayouts(JSON.parse(raw)) : []; } catch { return []; }
}
/** Keep the layouts in this browser; false when storage refused. */
export function storeLayouts(list: readonly SavedLayout[]): boolean {
  try { window.localStorage.setItem(LAYOUTS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
