/**
 * The rules of maximizing a pane of the map's column (layout.ts `#setMax`; TradingView's, Karl 2026-11-17), kept apart from the page so they
 * can be tested: which pane may be maximized, when a maximized one gives the column back, and what height a pane is saved at meanwhile.
 */

/** A pane of the map's column as the rules see it: its id and whether its switch has it open. */
export interface ColumnPane { id: string; open: boolean }

/**
 * Whether maximizing `id` changes anything: a desktop, the pane open, and something for it to take the room of: another pane open in the
 * column, or a column beside the map open (`sides`: a maximized chart takes the whole screen, the flow column and the book folded away too;
 * Karl, 2026-11-17).
 */
export function canMaximize(id: string, panes: readonly ColumnPane[], phone: boolean, sides = false): boolean {
  const pane = panes.find(p => p.id === id);
  return !phone && !!pane?.open && (sides || panes.some(p => p !== pane && p.open));
}

/** What says which panes the column shows (in their order): one maximized stays so only while this is what it was maximized with. */
export function columnKey(panes: readonly ColumnPane[]): string { return panes.filter(p => p.open).map(p => p.id).join(); }

/**
 * Whether a maximized pane stays maximized after the column was laid out again: not when a pane was opened or closed (the maximized one
 * among them) or moved, so that what was asked for is seen; a change of anything else (Candles, the footprint) keeps it.
 */
export function staysMaximized(maxed: string | null, keyThen: string, keyNow: string): boolean { return maxed !== null && keyThen === keyNow; }

/**
 * The height a pane under the map is saved at: a maximized one, the height it comes back at (it stands over the whole column, and that is not
 * its height); one shrunk to fit the window (`fitted`, within a pixel), the height it was given (`own`); otherwise the height it shows.
 */
export function savedHeight(p: { maxed: boolean; shown: number; fitted?: number; own?: number; initial: number }): number {
  if (p.maxed) return p.own ?? p.initial;
  return p.fitted !== undefined && p.own !== undefined && Math.abs(p.shown - p.fitted) <= 1 ? p.own : p.shown;
}
