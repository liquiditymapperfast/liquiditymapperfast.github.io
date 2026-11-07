import type { RpcCall } from './protocol.ts';

/**
 * What the feeds worker's questions wait for while its recordings are read back (feeds.worker.ts). The others are answered at once: the
 * market list, the venues' own candles and open interest, and the taker flow, whose pane holds the live seconds back while its question is
 * out (app/flow-book.ts): it is asked again when the history lands.
 */
export const HISTORY_WAITS: ReadonlySet<RpcCall['method']> = new Set(['columns', 'footprint', 'prints', 'liquidations', 'printSums', 'sizes', 'profile', 'oiProfile', 'range', 'valueAreas', 'absorption', 'absorptionProfile', 'coverage', 'recover']);

/**
 * The newest hours of the recordings the map's own load is answered from meanwhile (`Engine.preview`): the window the map opens on before
 * the history (75 minutes: app/panes/heat-pane.ts) with the half span either side that a load asks for (app/column-holds.ts `columnReach`),
 * and room.
 */
export const PREVIEW_MS = 3 * 3_600_000;

/**
 * What a question waits for before the recorded history is in: nothing, the history, or the newest recordings or the history, whichever
 * comes first (`newest`: `Engine.preview`). Only the map's own load asks for that (`early`): it asks for its columns whole again when the
 * history lands (`columnsEarly`), and every other reader of columns (the depth pane's highlights, the alerts' depth, the scripts' depth)
 * takes an answer as final, so it waits for the day.
 */
export function waitOf(call: RpcCall): 'none' | 'history' | 'newest' {
  if (!HISTORY_WAITS.has(call.method)) return 'none';
  return call.method === 'columns' && call.early === true ? 'newest' : 'history';
}
