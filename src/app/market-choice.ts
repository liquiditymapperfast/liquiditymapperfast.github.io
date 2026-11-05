import type { AppState } from './store.ts';
import type { FlowBook } from './flow-book.ts';
import { oiFlowIds, type MapState } from './cvd/ids.ts';
import { aggregateIds } from './cvd/model.ts';
import { buildFamilies, familyKey, venueOfInstrument } from './cvd/families.ts';
import { kindOf } from './scope.ts';
import { MAX_PROFILE_INSTRUMENTS } from '../shared/footprint.ts';
import { OI_SAMPLE_VENUES } from '../shared/history.ts';

/**
 * Which markets the footprint (and the bar statistics' trade rows) and the open interest (the OI pane, the statistics' oi chg row, NL/NS and
 * the Long/Short pane) count, when a person picks them: two lists, apart, since spot markets have trades but no open interest.
 *
 * A pick is an exchange and a kind, `binance/perp` or `bybit/spot`, never an instrument id: the same pick means the same exchange's market
 * on whichever coin is open, so a layout or a saved page made on BTC can never put BTC's markets under an ETH chart. A pick is turned into
 * the market by the rule the ALL VENUES lines use (`buildFamilies`: one spot and one perpetual market per exchange, a market with recorded
 * flow first), over every market the source lists, whatever the venue chips and the Spot / Perp filter say. A pick with no such market on
 * this coin or source counts nothing and the picker says so; an empty list counts nothing (never every market, never the chart's).
 */

export type MarketKind = 'spot' | 'perp';
export interface CustomMarkets { footprint: string[]; oi: string[] }
export const NO_CUSTOM: Readonly<CustomMarkets> = { footprint: [], oi: [] };
/** At most this many picks a list (the footprint's limit on markets added together). */
export const MAX_PICKS = MAX_PROFILE_INSTRUMENTS;

const PICK = /^([a-z0-9]{1,24})\/(spot|perp)$/;
export const pickOf = (family: string, kind: MarketKind): string => `${family}/${kind}`;
export function parsePick(pick: string): { family: string; kind: MarketKind } | null { const m = PICK.exec(pick); return m ? { family: m[1]!, kind: m[2] as MarketKind } : null; }
/** Whether a pick can count for open interest: a perpetual on an exchange whose open interest is read. */
export const oiPickable = (pick: string): boolean => { const p = parsePick(pick); return p !== null && p.kind === 'perp' && OI_SAMPLE_VENUES.includes(p.family); };

/** A saved list, checked: picks of the right form only (perpetuals of OI venues for `oi`), each once, at most `MAX_PICKS`. */
export function readPicks(value: unknown, oi: boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((p): p is string => typeof p === 'string' && (oi ? oiPickable(p) : parsePick(p) !== null)))].slice(0, MAX_PICKS);
}
export function readCustomMarkets(value: unknown): CustomMarkets {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof CustomMarkets, unknown>>;
  return { footprint: readPicks(v.footprint, false), oi: readPicks(v.oi, true) };
}

/** One choice the picker offers: a pick and the market it stands for on this coin (null where there is none). */
export interface PickOption { pick: string; family: string; kind: MarketKind; id: string | null }

const choices = new WeakMap<readonly AppState['markets'][number][], Map<string, string>>();
/**
 * Every pick this source and coin have a market for, to the market: over every market listed (no chips, no filter), one spot and one
 * perpetual per exchange, those whose flow is recorded first (as the ALL VENUES lines choose). Worked out once per market list and flow.
 */
function marketsByPick(state: Pick<AppState, 'markets'>, flow: FlowBook | null): Map<string, string> {
  const held = flow ? null : choices.get(state.markets);
  if (held) return held;
  const ids = state.markets.map(m => m.instrumentId ?? m.id).filter((id): id is string => !!id);
  const recorded = flow ? ids.filter(id => { const s = flow.get(id); return s !== undefined && !s.empty; }) : [];
  const ordered = [...new Set([...recorded, ...ids])], out = new Map<string, string>();
  for (const family of buildFamilies(ordered, id => kindOf(state.markets, id))) for (const lane of family.lanes) out.set(pickOf(family.key, lane.kind), lane.id);
  if (!flow) choices.set(state.markets, out);
  return out;
}

/** The picker's rows: every pick this coin has (perpetuals of OI venues only for `oi`), then the picks kept that it has no market for. */
export function pickOptions(state: Pick<AppState, 'markets'>, flow: FlowBook | null, picked: readonly string[], oi: boolean): PickOption[] {
  const byPick = marketsByPick(state, flow), out: PickOption[] = [];
  for (const [pick, id] of byPick) { const p = parsePick(pick)!; if (!oi || oiPickable(pick)) out.push({ pick, family: p.family, kind: p.kind, id }); }
  out.sort((a, b) => a.family.localeCompare(b.family) || (a.kind === b.kind ? 0 : a.kind === 'perp' ? -1 : 1));
  for (const pick of picked) if (!byPick.has(pick)) { const p = parsePick(pick); if (p) out.push({ pick, family: p.family, kind: p.kind, id: null }); }
  return out;
}

/** The markets of a list on this coin, sorted, each once (the picks with no market here count nothing). */
export function resolvePicks(state: Pick<AppState, 'markets'>, flow: FlowBook | null, picks: readonly string[], oi: boolean): string[] {
  const byPick = marketsByPick(state, flow);
  return [...new Set(picks.filter(p => !oi || oiPickable(p)).map(p => byPick.get(p)).filter((id): id is string => !!id))].sort().slice(0, MAX_PICKS);
}

/**
 * The perpetuals the ALL VENUES lines count on an exchange whose open interest is read: the OI pane's markets with venues added together.
 * Whatever the Spot / Perp filter says (`oiFlowIds`): under Spot these are the perpetuals Both counts, not none.
 */
export function oiVenueIds(state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope'> & MapState, flow: FlowBook): string[] {
  return aggregateIds(flow, oiFlowIds(state, flow.ids), id => kindOf(state.markets, id)).filter(id => kindOf(state.markets, id) === 'perp' && OI_SAMPLE_VENUES.includes(familyKey(venueOfInstrument(id)))).sort();
}

/**
 * The open-interest markets that are added together: the ALL VENUES perpetuals ('all'), the picked ones ('custom'); null for 'chart', which
 * is the chart market alone (or the reference market standing in for it, as the pane says).
 */
export function oiMarketIds(state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope' | 'oiMarkets' | 'customMarkets'> & MapState, flow: FlowBook): string[] | null {
  return state.oiMarkets === 'all' ? oiVenueIds(state, flow) : state.oiMarkets === 'custom' ? resolvePicks(state, flow, state.customMarkets.oi, true) : null;
}
