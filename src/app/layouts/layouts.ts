import { LAYOUT_KEYS, readSettings, type AppState, type Settings } from '../store.ts';
import { PANE_SHOW_KEY, legacyPlan, readPlan, samePlan, type DockPlan } from './dock-model.ts';

/**
 * Saved layouts: a name for the panes as they are arranged (order, heights, column widths) and the settings of what the chart shows
 * (`LAYOUT_KEYS`). Not the coin, the venues, the theme, the time zone or the sounds, and not two things that belong to a person's own chart:
 * the VWAP anchors (each a moment of one coin) and the Volume profile's zone (a time-zone choice). They are kept in this browser
 * (`hlm-layouts-v1`) and can be written to a file and read back; a file can come from anywhere, so every field goes through `readSettings`.
 */

export const LAYOUTS_KEY = 'hlm-layouts-v1', MAX_LAYOUTS = 20, MAX_NAME = 40, FILE_FORMAT = 'liquiditymapperfast-layouts', MAX_FILE_CHARS = 1_000_000;
/** Midnight of 1 January 3000 (ms): a layout is not older or newer than that. */
const MAX_SAVED_AT = 32_503_680_000_000;

/**
 * Where the panes are: their order and the heights of those under the map with a fixed height, and the widths of the flow column and the book (px,
 * as they were laid out). `dock` says which side each side pane stands on and how a column is shared (dock-model.ts); a layout from before it has
 * none, and then the flow column is left of the map and the book right of it. The widths stay as the first versions wrote them (`flowW` the
 * flow column's, `sideW` the book's, wherever each stands), so that an older page can read what a newer one wrote.
 */
export interface PaneArrangement { order: string[]; heights: Record<string, number>; sideW: number; flowW: number; dock?: DockPlan }
export interface SavedLayout { name: string; savedAt: number; settings: Partial<Settings>; panes: PaneArrangement }

/**
 * How wide the flow column and the book start (px) in a window `width` px wide (Karl, 2026-10-17: on a large screen they began very narrow;
 * 2026-10-25: on a small one they were too wide, 420 px of 1,280). The map takes the golden section of the window, 61.8 %, and the two columns
 * share the rest, 19.1 % each, never less than they began at before (300 and 420) in a window of 1,600 px and over, so those are as they were.
 * Narrower windows take them down in proportion to the window, to floors under which their content starts to give (the book's header goes from
 * three rows to four under about 330 px; the flow column's venue names are cut under about 260). The stylesheet says the same (`main` in
 * styles.css: `max(clamp(350px, 26.25vw, 420px), 19.1vw)`), so the columns follow the window until a column is dragged.
 */
export const COLUMN_SHARE = 0.191, MIN_FLOW_W = 300, MIN_SIDE_W = 420, FLOW_FLOOR_W = 260, SIDE_FLOOR_W = 350, FULL_WIDTH = 1600;
export function defaultColumns(width: number): { flowW: number; sideW: number } {
  const w = Math.max(0, width), share = Math.round(w * COLUMN_SHARE);
  const scaled = (full: number, floor: number): number => Math.round(Math.min(full, Math.max(floor, w * full / FULL_WIDTH)));
  return { flowW: Math.max(scaled(MIN_FLOW_W, FLOW_FLOOR_W), share), sideW: Math.max(scaled(MIN_SIDE_W, SIDE_FLOOR_W), share) };
}
/**
 * The same widths as the stylesheet lays them out (`--flow-w`, `--side-w` in styles.css), unrounded: a column that was not dragged is that
 * wide, to the fraction of a pixel. The desktop's fold weighs the map's pane with them (Sol, 2026-11-03: a pane predicted at 520 px was 519).
 */
export function stylesheetColumns(width: number): { flowW: number; sideW: number } {
  const w = Math.max(0, width), share = w * COLUMN_SHARE;
  const scaled = (full: number, floor: number): number => Math.min(full, Math.max(floor, w * full / FULL_WIDTH));
  return { flowW: Math.max(scaled(MIN_FLOW_W, FLOW_FLOOR_W), share), sideW: Math.max(scaled(MIN_SIDE_W, SIDE_FLOOR_W), share) };
}

/** A name as it is kept: spaces collapsed and trimmed, at most `MAX_NAME` characters; null when nothing is left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return name ? name : null;
}
const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The name for a copy of `name`: `wording(name)` ("Name copy"), then "Name copy 2", "Name copy 3" … for the first that is free. The name is cut
 * to leave room for the wording and the number, so that the end of the new name is never what `cleanName` cuts away (a long name would otherwise
 * come out as one that is taken already, every time). Null when none is free within the layouts a person can have.
 */
export function copyName(name: string, wording: (shown: string) => string, taken: (candidate: string) => boolean): string | null {
  const extra = wording('').length;
  for (let n = 1; n <= MAX_LAYOUTS + 1; n++) {
    const ending = n === 1 ? '' : ` ${n}`;
    const candidate = cleanName(`${wording(name.slice(0, Math.max(1, MAX_NAME - extra - ending.length)).trimEnd())}${ending}`);
    if (candidate && !taken(candidate)) return candidate;
  }
  return null;
}

/** The switches that open a pane (the Scripts pane is the person's own: a layout does not decide it): what a layout that keeps the panes alone carries of `show`. */
export const PANE_SWITCHES: readonly (keyof AppState['show'])[] = Object.entries(PANE_SHOW_KEY).filter(([id]) => id !== 'script').map(([, key]) => key);
/** The settings of a layout that keeps the panes alone: which are open, and nothing else. */
export function paneSettings(state: AppState): Partial<Settings> {
  return { show: Object.fromEntries(PANE_SWITCHES.map(key => [key, state.show[key]])) as Settings['show'] };
}

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

/**
 * What Undo puts back after an action changed the settings from `before` to `after`: each setting the action changed, if it still stands as the
 * action left it (`now`), and the switches one by one. What the person did since to anything else is not touched.
 */
export function undoPatch(before: Partial<Settings>, after: Partial<Settings>, now: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of LAYOUT_KEYS) {
    if (key === 'show') {
      const b = before.show, a = after.show, n = now.show;
      if (!b || !a || !n) continue;
      const show: Record<string, boolean> = { ...n };
      let changed = false;
      for (const k of Object.keys(b) as (keyof typeof b)[]) if (b[k] !== a[k] && a[k] === n[k]) { show[k] = b[k]; changed = true; }
      if (changed) out.show = show;
    } else if (!same(before[key], after[key]) && same(after[key], now[key])) out[key] = before[key];
  }
  return out as Partial<Settings>;
}

/**
 * An Undo patch made whole for the store. A snapshot leaves out the VWAP anchors and the Volume profile's zone (`settingsOf`), so the VWAP and
 * profile settings a patch carries would write those two back as missing: they are laid back from the chart as it stands, which an Undo never changes.
 */
export function completeSettings(patch: Partial<Settings>, current: AppState): Partial<Settings> {
  const out: Partial<Settings> = { ...patch };
  if (out.vwap) out.vwap = { ...out.vwap, anchors: current.vwap.anchors };
  if (out.traded) out.traded = { ...out.traded, zone: current.traded.zone };
  return out;
}

/** The same arrangement of the panes: the order, the heights and the places of the panes within a few pixels (what is measured shifts by a pixel or two). */
export function samePanes(a: PaneArrangement, b: PaneArrangement, tolerance = 8): boolean {
  if (a.order.join() !== b.order.join()) return false;
  for (const id of new Set([...Object.keys(a.heights), ...Object.keys(b.heights)])) if (Math.abs((a.heights[id] ?? 0) - (b.heights[id] ?? 0)) > tolerance) return false;
  return samePlan(a.dock ?? legacyPlan(a.flowW, a.sideW), b.dock ?? legacyPlan(b.flowW, b.sideW), tolerance);
}

/**
 * The settings a layout carries, as they will be applied: each field it names read as a saved page's is, the others left out (a layout saved
 * with the panes alone carries the switches that open them and nothing else), and not the VWAP anchors or the Volume profile's zone.
 * Nothing else is kept, so nothing else is written back. Of the switches too, only those it names: the others are left as they are.
 */
export function carriedSettings(raw: Partial<Settings>): Partial<Settings> {
  const full = readSettings(raw), out: Record<string, unknown> = {};
  // A layout from when the profile along the top was the measure strip carries it as that: read into the profile's settings (`readSettings`), which it therefore names.
  const named = (key: string): boolean => Object.hasOwn(raw, key) || (key === 'traded' && Object.hasOwn(raw, 'measureStrip'));
  for (const key of LAYOUT_KEYS) if (named(key)) out[key] = full[key];
  if (out.vwap) { const { anchors: _anchors, ...vwap } = full.vwap; out.vwap = vwap; }
  if (out.traded) { const { zone: _zone, ...traded } = full.traded; out.traded = traded; }
  if (out.show) {
    // Two switches follow from something else in a layout from before (readSettings): the Bar stats table showed with the footprint until it had its
    // own switch, and the Volume profile along the top was the measure strip.
    const given = (raw.show && typeof raw.show === 'object' ? raw.show : {}) as Record<string, unknown>;
    out.show = Object.fromEntries(Object.entries(full.show).filter(([key]) => typeof given[key] === 'boolean' || (key === 'stats' && typeof given.footprint === 'boolean') || (key === 'traded' && Object.hasOwn(raw, 'measureStrip'))));
  }
  return out as Partial<Settings>;
}

/**
 * What applying a layout's settings sets: the chart as it is now, with each field the layout carries on top of it, read as a saved page's is
 * (a layout that carries only some fields, a preset or one saved with the panes alone, leaves the rest as they are, not as the page starts
 * with them; of the switches too), and this chart's own VWAP anchors and zone kept.
 */
export function settingsToApply(saved: Partial<Settings>, current: AppState): Settings {
  const settings = readSettings({ ...settingsOf(current), ...saved, ...(saved.show ? { show: { ...current.show, ...saved.show } } : {}) });
  return { ...settings, vwap: { ...settings.vwap, anchors: current.vwap.anchors }, traded: { ...settings.traded, zone: current.traded.zone } };
}

/** A pane arrangement from storage or a file, or null: ids are strings, sizes are finite and within reason. */
export function readArrangement(raw: unknown): PaneArrangement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, size = (v: unknown, lo: number, hi: number): number | null => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null;
  const order = Array.isArray(r.order) ? r.order.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 40).slice(0, 40) : [];
  const heights: Record<string, number> = {};
  if (r.heights && typeof r.heights === 'object') for (const [id, h] of Object.entries(r.heights as Record<string, unknown>).slice(0, 40)) { const v = size(h, 40, 4_000); if (v !== null && id.length <= 40) heights[id] = v; }
  const sideW = size(r.sideW, 200, 4_000), flowW = size(r.flowW, 150, 4_000), dock = readPlan(r.dock);
  return sideW === null || flowW === null ? null : { order, heights, sideW, flowW, ...(dock ? { dock } : {}) };
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
 * `mapMin`, its own CSS minimum), else all shrunk in proportion, none below its own minimum: a pane that would come out under it keeps it, and
 * the others share what is left in proportion (a proportion with the minimums put back on afterwards added up to more than the room). A layout
 * from a taller window, or a window made smaller, would otherwise push the last pane off the screen.
 */
export function fitHeights(want: readonly number[], mins: readonly number[], avail: number, mapMin = MAP_MIN_PX): number[] {
  const room = avail - Math.max(mapMin, avail * MAP_MIN_SHARE), total = want.reduce((a, b) => a + b, 0);
  if (!(room > 0 && total > room)) return [...want];
  const out = want.map(() => 0), pinned = want.map(() => false), min = (i: number): number => mins[i] ?? 0;
  for (let pass = 0; pass <= want.length; pass++) {
    const free = want.reduce((sum, h, i) => sum + (pinned[i] ? 0 : h), 0), left = room - want.reduce((sum, _, i) => sum + (pinned[i] ? min(i) : 0), 0);
    const f = free > 0 ? Math.max(0, left) / free : 0;
    let again = false;
    want.forEach((h, i) => { if (pinned[i]) return; if (h * f < min(i)) { pinned[i] = true; again = true; } else out[i] = Math.floor(h * f); });
    if (!again) break;
  }
  return want.map((_, i) => pinned[i] ? min(i) : out[i]!);
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
    // A date a clock can show (a file can hold any number, and a date past the year 3000 makes the page's date formatting throw).
    const savedAt = typeof r.savedAt === 'number' && r.savedAt > 0 && r.savedAt < MAX_SAVED_AT ? Math.round(r.savedAt) : 0;
    out.push({ name, savedAt, settings: carriedSettings(r.settings as Partial<Settings>), panes });
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
