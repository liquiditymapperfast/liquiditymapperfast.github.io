import type { AppState, Settings, Store } from '../store.ts';
import { t } from '../i18n.ts';
import { toast } from '../toast.ts';
import { LAYOUTS_KEY, MAX_LAYOUTS, changedSettings, cleanName, completeSettings, copyName, loadLayouts, paneSettings, samePanes, settingsOf, settingsToApply, storeLayouts, undoPatch, upsert, type PaneArrangement, type SavedLayout } from './layouts.ts';
import { PRESETS, buildPreset, type PresetDef, type PresetEnv } from './presets.ts';
import { readActive, sameShot, shotOf, type Active } from './active.ts';
import { PANE_SHOW_KEY, type Side, type SidePaneId } from './dock-model.ts';

/** What arranges the panes (the page's Layout), as the actions below and the layouts panel see it. */
export interface PaneHost {
  arrangement(): PaneArrangement; apply(a: PaneArrangement): void; defaults(): PaneArrangement; swapSides(): void;
  /** The room a layout is made for now: the window, and the map's column. */
  env(): PresetEnv;
}

/** What the screen was: the panes as they stood, the chart's settings (which panes are open among them), and which layout it was showing. */
interface Snapshot { panes: PaneArrangement; settings: Partial<Settings>; active: Active | null }

export const ACTIVE_KEY = 'hlm-layout-active-v1';
const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * Everything a person does to the layout: apply one that is ready-made or saved, save, update, rename, copy and delete their own, hide a
 * pane, flip a column. What changes the screen offers its way back (`undoable`), and the layout last applied or saved is remembered so
 * that the panel can say which one the screen is showing and whether it has been changed since.
 */
export class LayoutActions {
  constructor(readonly store: Store, readonly host: PaneHost) {}

  snapshot(): Snapshot { return { panes: this.host.arrangement(), settings: structuredClone(settingsOf(this.store.state)), active: this.active() }; }
  /**
   * Put back what an action changed (`before` to `after`) and nothing else: the panes if nobody has moved them since, each setting it changed that still
   * stands as it left it. A person who goes on working in the seconds the Undo is offered keeps what they did.
   */
  #undo(before: Snapshot, after: Snapshot): void {
    const now = this.snapshot(), untouched = samePanes(after.panes, now.panes);
    if (untouched && !samePanes(before.panes, after.panes)) this.host.apply(before.panes);
    const patch = completeSettings(undoPatch(before.settings, after.settings, now.settings), this.store.state);
    if (Object.keys(patch).length) this.store.set(patch);
    if (untouched) this.#setActive(before.active);
  }
  /** Do `change`, say so, and offer to put back what it changed. */
  #undoable(text: string, change: () => void): void {
    const before = this.snapshot();
    change();
    const after = this.snapshot();
    toast(text, { action: { label: t('Undo'), run: () => this.#undo(before, after) } });
  }

  // ---- which layout the screen is showing --------------------------------------------------------------------------------
  active(): Active | null {
    try { return readActive(JSON.parse(window.localStorage.getItem(ACTIVE_KEY) ?? 'null')); } catch { return null; }
  }
  #setActive(a: Active | null): void {
    try { if (a) window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(a)); else window.localStorage.removeItem(ACTIVE_KEY); } catch { /* storage unavailable */ }
  }
  /** The screen is this layout now: taken as it is drawn, a frame on, once the page has laid out what was asked for. */
  #remember(kind: Active['kind'], id: string): void {
    requestAnimationFrame(() => this.#setActive({ kind, id, shot: shotOf(this.host.arrangement(), this.store.state.show) }));
  }
  /**
   * A page nobody has arranged yet is the Default layout, and the panel says so: of the layouts only this record is written on a first visit (the page's
   * own arrangement and the saved layouts are written only by something a person did), and only when nothing else is stored.
   */
  seedDefault(): void {
    try { if (this.active() || [LAYOUTS_KEY, 'hlm-layout-v2', 'hlm-layout-v3'].some(key => window.localStorage.getItem(key) !== null)) return; } catch { return; }
    this.#remember('preset', 'default');
  }
  /** The name of the layout the screen is showing, or null (none was applied, or it has been deleted since). */
  activeName(): string | null {
    const a = this.active();
    if (!a) return null;
    if (a.kind === 'preset') return PRESETS.find(p => p.id === a.id)?.name() ?? null;
    return loadLayouts().find(l => sameName(l.name, a.id))?.name ?? null;
  }
  /** Whether the screen differs from the layout it was last set to (a pane moved, closed or resized since). */
  modified(): boolean {
    const a = this.active();
    return a !== null && !sameShot(shotOf(this.host.arrangement(), this.store.state.show), a.shot);
  }

  // ---- ready-made and saved layouts ------------------------------------------------------------------------------------
  /** The chart's switches with those a layout names laid over them: a pane opens or closes, the rest is as it was. */
  #setShow(show: Partial<AppState['show']>): void {
    const now = this.store.state;
    this.store.set(changedSettings(settingsToApply({ show: { ...now.show, ...show } }, now), now));
  }
  applyPreset(def: PresetDef): void {
    this.#undoable(t('Applied “{name}”.', { name: def.name() }), () => {
      const built = buildPreset(def, this.host.env());
      this.host.apply(built.arrangement);
      this.#setShow(built.show);
      this.#remember('preset', def.id);
    });
  }
  /** Arranges the panes first and then sets the settings, so the panes it shows get their splitters from the new arrangement. */
  applySaved(layout: SavedLayout): void {
    this.#undoable(t('Applied “{name}”.', { name: layout.name }), () => {
      this.host.apply(layout.panes);
      const now = this.store.state;
      this.store.set(changedSettings(settingsToApply(layout.settings, now), now));
      this.#remember('saved', layout.name);
    });
  }

  // ---- a person's own ---------------------------------------------------------------------------------------------------
  /** The screen as a layout: the panes and which are open, and with `withSettings` everything the chart shows as well (the footprint, the timeframe, the colours …). */
  #capture(name: string, withSettings: boolean): SavedLayout {
    const state = this.store.state;
    return { name, savedAt: Date.now(), settings: withSettings ? settingsOf(state) : paneSettings(state), panes: this.host.arrangement() };
  }
  save(raw: string, withSettings: boolean): { ok: true; replaced: boolean; name: string } | { ok: false; why: 'name' | 'full' | 'storage' } {
    const name = cleanName(raw);
    if (!name) return { ok: false, why: 'name' };
    const list = loadLayouts(), replaced = list.some(l => sameName(l.name, name)), next = upsert(list, this.#capture(name, withSettings));
    if (!next) return { ok: false, why: 'full' };
    if (!storeLayouts(next)) return { ok: false, why: 'storage' };
    this.#remember('saved', name);
    return { ok: true, replaced, name };
  }
  /** Keep what is on the screen under a name that is there: with the chart's settings where it had them. */
  update(name: string): boolean {
    const list = loadLayouts(), at = list.find(l => sameName(l.name, name));
    if (!at) return false;
    const next = upsert(list, this.#capture(at.name, Object.keys(at.settings).some(k => k !== 'show')));
    if (!next || !storeLayouts(next)) return false;
    this.#remember('saved', at.name);
    return true;
  }
  rename(from: string, to: string): 'ok' | 'name' | 'taken' | 'storage' {
    const name = cleanName(to), list = loadLayouts(), at = list.findIndex(l => sameName(l.name, from));
    if (!name || at < 0) return 'name';
    if (list.some((l, i) => i !== at && sameName(l.name, name))) return 'taken';
    const wasActive = this.active()?.kind === 'saved' && sameName(this.active()!.id, from);
    if (!storeLayouts(list.map((l, i) => i === at ? { ...l, name } : l))) return 'storage';
    if (wasActive) this.#setActive({ ...this.active()!, id: name });
    return 'ok';
  }
  /** A copy of a layout under a name that is free: "Name copy", "Name copy 2". Or why there is none: the list is full, or the browser did not keep it. */
  duplicate(name: string): { ok: true; name: string } | { ok: false; why: 'full' | 'storage' } {
    const list = loadLayouts(), at = list.find(l => sameName(l.name, name));
    if (!at || list.length >= MAX_LAYOUTS) return { ok: false, why: 'full' };
    const copy = copyName(at.name, shown => t('{name} copy', { name: shown }), candidate => list.some(l => sameName(l.name, candidate)));
    const made = copy ? upsert(list, { ...at, name: copy, savedAt: Date.now() }) : null;
    if (!copy || !made) return { ok: false, why: 'full' };
    return storeLayouts(made) ? { ok: true, name: copy } : { ok: false, why: 'storage' };
  }
  /**
   * Called when the list of saved layouts changes from outside the panel that shows it (the toast's Undo of a delete): the Layouts panel that is open
   * redraws. The panel that was opened last sets it, so it is the one that is open now, not the one the deleted layout was deleted from.
   */
  onListChanged: (() => void) | null = null;
  /** Delete one of the person's layouts; the toast brings it back, in its place. False when the browser did not let the page keep the change. */
  remove(name: string): boolean {
    const list = loadLayouts(), at = list.findIndex(l => sameName(l.name, name));
    if (at < 0) return true;
    const gone = list[at]!;
    if (!storeLayouts(list.filter((_, i) => i !== at))) return false;
    toast(t('Deleted “{name}”.', { name: gone.name }), { action: { label: t('Undo'), run: () => {
      // Brought back only where it fits: into a full list, or beside a layout that took its name since, it would push another one out or be read as a duplicate.
      const now = loadLayouts();
      if (now.length >= MAX_LAYOUTS || now.some(l => sameName(l.name, gone.name))) { toast(t('“{name}” could not be brought back: its name is taken, or there are {n} layouts already.', { name: gone.name, n: MAX_LAYOUTS })); return; }
      if (!storeLayouts([...now.slice(0, at), gone, ...now.slice(at)])) { toast(t('This browser did not let the page keep it.')); return; }
      this.onListChanged?.();
    } } });
    return true;
  }

  // ---- panes ------------------------------------------------------------------------------------------------------------
  /** Open or close a pane: the page's switch for it. */
  setPane(id: string, on: boolean): void {
    const key = PANE_SHOW_KEY[id];
    if (key && this.store.state.show[key] !== on) this.store.set({ show: { ...this.store.state.show, [key]: on } });
  }
  hide(id: string, name: string): void { this.#undoable(t('Hid {name}.', { name }), () => this.setPane(id, false)); }
  /** The panes each column had open when it was last folded away by `toggleColumn`: opened again, a pane that was shut on purpose before stays shut. */
  readonly #folded: Record<Side, SidePaneId[]> = { left: [], right: [] };
  /** A column closed if any pane in it is open, else opened with the panes it had open when it was closed (all it holds, if it was not closed from here). */
  toggleColumn(side: Side): void {
    const ids = this.host.arrangement().dock?.[side] ?? [], open = ids.filter(id => this.store.state.show[PANE_SHOW_KEY[id]!]);
    if (open.length) { this.#folded[side] = open; for (const id of open) this.setPane(id, false); return; }
    const back = this.#folded[side].filter(id => ids.includes(id));
    for (const id of back.length ? back : ids) this.setPane(id, true);
  }
}
