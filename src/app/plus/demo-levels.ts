/**
 * The page's own levels control in the Plus demo (plus/demo/): the same component the map's column opens, bound to the demo's store
 * (`DemoStore`), never the page's settings, so trying its switches in the presentation changes nothing on the visitor's map. Every choice
 * is open there (the demo shows what Plus adds); the Split choice is left out, as the demo has no columns to split.
 */
import { createLevelsControl, type LevelsModel } from '../levels-control.ts';
import type { DemoStore } from './demo/store.ts';

/** The demo's store as the levels control reads and writes it: the same three kinds, and its traders as the control's group. */
export function demoLevels(store: DemoStore): LevelsModel {
  return {
    get: () => { const s = store.get(); return { liq: s.liq, stops: s.stops, takes: s.takes, group: s.traders === 'profitable' ? 'profitable' : 'all' }; },
    set: change => {
      store.set({
        ...(typeof change.liq === 'boolean' ? { liq: change.liq } : {}), ...(typeof change.stops === 'boolean' ? { stops: change.stops } : {}),
        ...(typeof change.takes === 'boolean' ? { takes: change.takes } : {}),
        ...(change.group === 'profitable' || change.group === 'all' ? { traders: change.group === 'profitable' ? 'profitable' as const : 'everyone' as const } : {}),
      });
    },
    subscribe: listener => store.subscribe(() => listener()),
    member: () => true,
  };
}

/** The demo's `control`: the levels control built into the demo's card, bound to its store, with no Split; `destroy` stops it and takes it out. */
export function demoControl(host: HTMLElement, store: DemoStore): { destroy(): void } {
  const control = createLevelsControl(demoLevels(store), { locked: () => {}, hideSplit: true });
  control.root.classList.add('lv-in-demo');
  host.append(control.root);
  return { destroy: () => { control.destroy(); control.root.remove(); } };
}
