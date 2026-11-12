import type { RangeLine } from './stats.ts';
import type { RangePane, RangeSelection } from './selection.ts';

/**
 * What a pane under the map gives the Range tool so that a stretch selected in it is summed up in its own terms (Karl, 2026-11-12: a selection
 * in the OI pane summed up the map's market orders). The pane owns the arithmetic: it reads what it drew itself (the same series, venues, cut
 * and replay moment), asks for nothing and starts no loading, and says when that changed (`RangeTool.paneChanged`); the tool only lays the
 * lines out and keeps a live selection's end on the clock.
 */
export interface RangeProvider {
  /** The pane, and its name in the panel's Show menu. */
  readonly pane: RangePane;
  title(): string;
  /** The length of the bars the pane draws now (ms): a drag in it holds whole bars. */
  barMs(): number;
  /** The summary of `sel`, line by line; `shown`: whether the pane is on screen (a hidden pane says it, and what it last held). */
  lines(sel: RangeSelection, shown: boolean): RangeLine[];
  /** Whether the pane is shown now. */
  shown(): boolean;
}
