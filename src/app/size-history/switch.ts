import { t } from '../i18n.ts';
import type { Store } from '../store.ts';
import { heading, switchRow } from '../ui.ts';

/**
 * The Flow history's switch (`show.sizes`), the same rows in the flow column's settings and in the Bar stats' settings (Karl, 2026-11-20:
 * reachable from both), on a phone too. It is no button of the top bar: a pane that only these two read from does not take one there.
 */
export function flowHistoryRows(store: Store): HTMLElement[] {
  return [
    heading(t('Flow history')),
    switchRow(t('Show the Flow history'), t("A pane under the chart: liquidations, open interest's change and market orders in six size bands, candle by candle, the most unusual amounts the brightest."),
      store.state.show.sizes, on => store.set({ show: { ...store.state.show, sizes: on } })),
  ];
}
