import type { AppState } from '../store.ts';
import type { FlowBook } from '../flow-book.ts';
import { flowIds } from '../cvd/ids.ts';
import { aggregateIds } from '../cvd/model.ts';
import { kindOf } from '../scope.ts';
import { unrecorded, type CandleFlow, type DeltaTrack, type FlowCache } from './candles.ts';

/**
 * The part of the Delta pane's work that the volume profile along the top of the map does too: which markets the delta is taken over, asking
 * the flow book for the history the candles need, and each candle's flow. One copy, so the profile and the pane always count the same markets.
 */

/** What loading the flow needs of the hub: the flow book and its two loaders (each a no-op once what was asked for is held). */
export interface FlowLoader {
  readonly flow: FlowBook;
  ensureFlow(ids: readonly string[], from: number): Promise<void>;
  ensureFlowMinutes(ids: readonly string[], from: number, to: number): Promise<void>;
}

/** The page holds flow a second at a time for a day; minutes are asked in blocks of six hours so a view moving back reuses them. */
export const HISTORY_CAP_MS = 24 * 3_600_000;
const MINUTES_FROM_MS = 6 * 3_600_000;

/** The markets the delta is taken over: those of the flow column's ALL VENUES lines (the venues switched on, inside the Spot / Perp filter). */
export function deltaIds(state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope' | 'levels' | 'bookGone'>, flow: FlowBook): string[] {
  return aggregateIds(flow, flowIds(state, flow.ids), id => kindOf(state.markets, id));
}

/** Ask the flow book for what candles from `from` need: the seconds the page holds (a day), and the minutes before them, as the flow column asks for them. */
export function ensureDeltaFlow(hub: FlowLoader, loadIds: string[], from: number, now: number): void {
  const flow = hub.flow, secondsFrom = Math.max(now - HISTORY_CAP_MS, from - 60_000);
  void hub.ensureFlow(loadIds, secondsFrom);
  if (from < secondsFrom - 60_000) {
    let latest = -Infinity;
    for (const id of loadIds) { const first = flow.get(id)?.span?.first; if (first !== undefined && first * 1000 > latest) latest = first * 1000; }
    if (latest === -Infinity && !flow.missing(loadIds, secondsFrom).length) latest = now;
    if (latest > -Infinity) void hub.ensureFlowMinutes(loadIds, Math.floor((from - 3_600_000) / MINUTES_FROM_MS) * MINUTES_FROM_MS, Math.ceil((latest + 120_000) / 3_600_000) * 3_600_000);
  }
}

/**
 * Each candle's flow over `ids` from `starts` (the closed ones worked out once in `cache`), as `raw` and as the pane counts it (`flows`: a long
 * stretch with no trade on any market left out as not recorded, `unrecorded`), and the first moment any of the markets holds flow (ms).
 * `raw` lets a reader tell a candle nothing was recorded in from one taken as not recorded; both are null in `flows`.
 */
export function deltaFlows(cache: FlowCache, flow: { track(id: string): DeltaTrack | undefined; readonly loads: number }, ids: readonly string[], starts: readonly number[], tf: number, now: number): { raw: (CandleFlow | null)[]; flows: (CandleFlow | null)[]; earliest: number | null } {
  const tracks = ids.flatMap(id => { const track = flow.track(id); return track ? [track] : []; });
  let earliest: number | null = null;
  for (const track of tracks) if (track.first !== null && (earliest === null || track.first * 1000 < earliest)) earliest = track.first * 1000;
  const raw = cache.get(`${ids.join(',')}|${tf}|${flow.loads}`, tracks, starts, tf, now);
  return { raw, flows: unrecorded(starts, raw, tf, now), earliest };
}
