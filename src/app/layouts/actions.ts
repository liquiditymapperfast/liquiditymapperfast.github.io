import type { AppState, Store } from '../store.ts';
import { t } from '../i18n.ts';
import { toast } from '../toast.ts';
import { LAYOUTS_KEY, MAX_LAYOUTS, changedSettings, cleanName, loadLayouts, settingsOf, settingsToApply, storeLayouts, upsert, type PaneArrangement, type SavedLayout } from './layouts.ts';
import { PRESETS, buildPreset, type PresetDef, type PresetEnv } from './presets.ts';
import { readActive, sameShot, shotOf, type Active } from './active.ts';
import { PANE_SHOW_KEY, type Side } from './dock-model.ts';

/** What arranges the panes (the page's Layout), as the actions below and the layouts panel see it. */
export interface PaneHost {
  arrangement(): PaneArrangement; apply(a: PaneArrangement): void; defaults(): PaneArrangement; swapSides(): void;
  /** The room a layout is made for now: the window, and the map's column. */
  env(): PresetEnv;
}

/** What the screen was: the panes as they stood, which are open and what else is switched, and which layout it was showing. */
interface Snapshot { panes: PaneArrangement; show: AppState['show']; active: Active | null }

export const ACTIVE_KEY = 'hlm-layout-active-v1';
const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * Everything a person does to the layout: apply one that is ready-made or saved, save, update, rename, copy and delete their own, hide a
 * pane, flip a column. What changes the screen offers its way back (`undoable`), and the layout last applied or saved is remembered so
 * that the panel can say which one the screen is showing and whether it has been changed since.
 */
export class LayoutActions {
  constructor(readonly store: Store, readonly host: PaneHost) {}

  snapshot(): Snapshot { return { panes: this.host.arrangement(), show: { ...this.store.state.show }, active: this.active() }; }
  restore(s: Snapshot): void {
    this.host.apply(s.panes);
    this.store.set({ show: { ...s.show } });
    this.#setActive(s.active);
  }
  /** Do `change`, say so, and offer to put things back as they were. */
  #undoable(text: string, change: () => void): void {
    const before = this.snapshot();
    change();
    toast(text, { action: { label: t('Undo'), run: () => this.restore(before) } });
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
   * A page nobody has arranged yet is the Default layout, and the panel says so: nothing of the layouts is stored on a first visit (the page's own
   * arrangement, the saved layouts and this record are all written only by something a person did).
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
  /** The screen as a layout: the panes and which are open, and with `withSettings` everything the chart shows as well. */
  #capture(name: string, withSettings: boolean): SavedLayout {
    const state = this.store.state;
    return { name, savedAt: Date.now(), settings: withSettings ? settingsOf(state) : { show: { ...state.show } }, panes: this.host.arrangement() };
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
  /** A copy of a layout under a name that is free: "Name copy", "Name copy 2". */
  duplicate(name: string): string | null {
    const list = loadLayouts(), at = list.find(l => sameName(l.name, name));
    if (!at || list.length >= MAX_LAYOUTS) return null;
    const stem = t('{name} copy', { name: at.name });
    let copy = cleanName(stem) ?? stem, n = 2;
    while (list.some(l => sameName(l.name, copy))) copy = cleanName(`${stem} ${n++}`) ?? `${stem} ${n}`;
    const made = upsert(list, { ...at, name: copy, savedAt: Date.now() });
    return made && storeLayouts(made) ? copy : null;
  }
  /** Delete one of the person's layouts; the toast brings it back, in its place. */
  remove(name: string, restored: () => void = () => {}): void {
    const list = loadLayouts(), at = list.findIndex(l => sameName(l.name, name));
    if (at < 0) return;
    const gone = list[at]!;
    if (!storeLayouts(list.filter((_, i) => i !== at))) return;
    toast(t('Deleted “{name}”.', { name: gone.name }), { action: { label: t('Undo'), run: () => { const now = loadLayouts(); storeLayouts([...now.slice(0, at), gone, ...now.slice(at)].slice(0, MAX_LAYOUTS)); restored(); } } });
  }

  // ---- panes ------------------------------------------------------------------------------------------------------------
  /** Open or close a pane: the page's switch for it. */
  setPane(id: string, on: boolean): void {
    const key = PANE_SHOW_KEY[id];
    if (key && this.store.state.show[key] !== on) this.store.set({ show: { ...this.store.state.show, [key]: on } });
  }
  hide(id: string, name: string): void { this.#undoable(t('Hid {name}.', { name }), () => this.setPane(id, false)); }
  /** A column closed if any pane in it is open, else opened with the panes it holds. */
  toggleColumn(side: Side): void {
    const ids = this.host.arrangement().dock?.[side] ?? [], open = ids.filter(id => this.store.state.show[PANE_SHOW_KEY[id]!]);
    for (const id of ids) this.setPane(id, open.length === 0);
  }
}
