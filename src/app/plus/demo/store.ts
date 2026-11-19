/**
 * What the demo shows: its own small store, never the app's settings, so playing the demo or trying its switches changes nothing on the
 * person's map. The demo's chart, its scenes and its levels control (the built-in one, or the app's own passed to `mountDemo` as `control`)
 * all read and write this one store.
 *
 * - `get()` is the current choice, a frozen object (a new one after every change, so it can be kept and compared).
 * - `set(patch)` merges a patch. One kind always stays on: a patch whose result would have no kind on keeps the three kinds as they were
 *   (its `traders` still applies), so a control's switch for the last kind on does nothing. The whole patch is judged at once, so a patch
 *   that turns one kind off and another on is fine. Values of the wrong type are left out. Returns whether anything changed.
 * - `subscribe(listener)` calls `listener` with the new choice after every change (never for a patch that changed nothing) and returns the
 *   function that stops it.
 */

export type DemoTraders = 'everyone' | 'profitable';
export type DemoKind = 'liq' | 'stops' | 'takes';
export interface DemoLevels {
  /** Liquidation levels. */
  readonly liq: boolean;
  /** Stop-loss levels. */
  readonly stops: boolean;
  /** Take-profit levels (never added into the curve). */
  readonly takes: boolean;
  /** Whose levels: every trader's, or HyperTracker's profitable traders'. */
  readonly traders: DemoTraders;
}
export interface DemoStore {
  get(): DemoLevels;
  set(patch: Partial<DemoLevels>): boolean;
  subscribe(listener: (levels: DemoLevels) => void): () => void;
}

export const DEMO_KINDS: readonly DemoKind[] = ['liq', 'stops', 'takes'];
/** Where the demo starts: every kind, every trader. */
export const DEMO_START: DemoLevels = Object.freeze({ liq: true, stops: true, takes: true, traders: 'everyone' });

/** How many kinds `s` shows. */
export const kindsOn = (s: DemoLevels): number => (s.liq ? 1 : 0) + (s.stops ? 1 : 0) + (s.takes ? 1 : 0);
/** Whether `kind` is the one kind on, whose switch cannot turn it off. */
export const lastOn = (s: DemoLevels, kind: DemoKind): boolean => s[kind] && kindsOn(s) === 1;

export function createDemoStore(initial: DemoLevels = DEMO_START): DemoStore {
  let state: DemoLevels = kindsOn(initial) ? Object.freeze({ ...initial }) : DEMO_START;
  const listeners = new Set<(levels: DemoLevels) => void>();
  return {
    get: () => state,
    set(patch) {
      const kinds = { liq: state.liq, stops: state.stops, takes: state.takes };
      for (const k of DEMO_KINDS) { const v = patch[k]; if (typeof v === 'boolean') kinds[k] = v; }
      const traders = patch.traders === 'everyone' || patch.traders === 'profitable' ? patch.traders : state.traders;
      const next: DemoLevels = kinds.liq || kinds.stops || kinds.takes ? { ...kinds, traders } : { liq: state.liq, stops: state.stops, takes: state.takes, traders };
      if (next.liq === state.liq && next.stops === state.stops && next.takes === state.takes && next.traders === state.traders) return false;
      state = Object.freeze(next);
      for (const listener of [...listeners]) listener(state);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
