import type { AppState, Market, Scope } from './store.ts';
import type { LiveBook } from './wire.ts';
import { t } from './i18n.ts';

export const SCOPE_OPTIONS: readonly (readonly [Scope, string])[] = [['all', t('Both')], ['spot', t('Spot')], ['perp', t('Perp')]];

export type Kind = 'spot' | 'perp';
const kinds = new WeakMap<readonly Market[], Map<string, Kind>>();

/** Whether an instrument is a spot or a perpetual market (null when the market list does not say). */
export function kindOf(markets: readonly Market[], id: string): Kind | null {
  let map = kinds.get(markets);
  if (!map) {
    map = new Map();
    for (const m of markets) { const key = m.instrumentId ?? m.id; if (key) map.set(key, m.marketType === 'spot' ? 'spot' : m.marketType === 'perpetual' ? 'perp' : undefined as never); }
    kinds.set(markets, map);
  }
  return map.get(id) ?? null;
}

export const inScope = (scope: Scope, markets: readonly Market[], id: string): boolean => scope === 'all' || kindOf(markets, id) === scope;

type ScopeState = Pick<AppState, 'levels' | 'disabledVenues' | 'scope' | 'markets'>;

/** Books the liquidity views draw: enabled venues (the chips) that also match the Spot / Perp / Both filter. */
export function activeBooks(state: ScopeState): LiveBook[] {
  return (state.levels?.books ?? []).filter(b => !state.disabledVenues.includes(b.venue) && inScope(state.scope, state.markets, b.id));
}
export const activeIds = (state: ScopeState): string[] => activeBooks(state).map(b => b.id);

/** Enabled venue books per kind, for the toolbar (a filter that selects nothing says so). */
export function scopeCounts(state: ScopeState): Record<Kind, number> {
  const out: Record<Kind, number> = { spot: 0, perp: 0 };
  for (const b of state.levels?.books ?? []) { if (state.disabledVenues.includes(b.venue)) continue; const kind = kindOf(state.markets, b.id); if (kind) out[kind]++; }
  return out;
}

/** Whether the Spot / Perp filter hides a venue: none of its books is inside the filter, so its chip is dimmed. */
export function scopedOut(state: ScopeState, venue: string): boolean {
  return !(state.levels?.books ?? []).some(b => b.venue === venue && inScope(state.scope, state.markets, b.id));
}

/**
 * What a click on a venue's chip changes. A chip is a switch for a venue, but a dimmed one is a venue the filter is hiding, and switching
 * it on or off would change nothing anyone can see; a click on one means "show it", so the filter goes back to Both and the venue is
 * switched on. Any other chip switches its venue on or off.
 */
export function chipClick(state: ScopeState, venue: string): { disabledVenues: string[]; scope?: Scope } {
  const off = state.disabledVenues;
  if (scopedOut(state, venue)) return { disabledVenues: off.filter(id => id !== venue), scope: 'all' };
  return { disabledVenues: off.includes(venue) ? off.filter(id => id !== venue) : [...off, venue] };
}

/** Message for an empty view, or null when the filter leaves something to draw. */
export function emptyScopeMessage(state: ScopeState): string | null {
  if (state.scope === 'all' || !state.levels?.books.length || activeBooks(state).length) return null;
  return state.scope === 'spot' ? t('No spot venues are enabled. Choose Both, or switch a spot venue on.') : t('No perpetual venues are enabled. Choose Both, or switch a perpetual venue on.');
}
