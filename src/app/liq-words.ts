/**
 * The words Liquidation levels use wherever they are drawn (the map's stripe and column, the phone's Liq tab, the panel), by what is shown:
 * liquidation levels, stops, both added together, and the take profits beside them. Each a whole sentence or label of its own (`t()`), joined
 * by a middle dot where several are said together.
 */
import { t } from './i18n.ts';
import { clock } from './format.ts';
import type { LevelsKind, LiqLevelsSource } from './liq-levels.ts';
import type { LiqView } from './liq-view.ts';

/** What a side of a set of levels is called. Take profits are held with their sides swapped: the long side is the take profits of shorts. */
export function sideTitle(kind: LevelsKind, side: 'long' | 'short'): string {
  if (kind === 'stops') return side === 'long' ? t('Stops of longs') : t('Stops of shorts');
  if (kind === 'both') return side === 'long' ? t('Long liquidations and stops') : t('Short liquidations and stops');
  if (kind === 'takes') return side === 'long' ? t('Take profits of shorts') : t('Take profits of longs');
  return side === 'long' ? t('Long liquidations') : t('Short liquidations');
}
/** What a bin's count is: positions, orders, or both. */
export function countLabel(kind: LevelsKind): string {
  return kind === 'liq' ? t('Positions') : kind === 'both' ? t('Positions and orders') : t('Orders');
}
/** What a bin's largest one is. */
export function topLabel(kind: LevelsKind): string {
  return kind === 'liq' ? t('Largest position') : kind === 'both' ? t('Largest position or order') : t('Largest order');
}
/** What a side's two parts are (`LiqLevels.longIso` and `longCross`). */
export function splitLabel(kind: LevelsKind): string {
  return kind === 'liq' ? t('Isolated / cross margin') : kind === 'both' ? t('Liquidations / stops') : t('Whole position / own size');
}

/**
 * Why nothing of the view is drawn (the column, the Liq tab), or '' when it is: loading, not read, out of date, or not in the snapshot (no
 * proven list, no groups or stops there yet). A view of both says which part is missing.
 */
export function liqWhy(src: Pick<LiqLevelsSource, 'state' | 'view' | 'levels' | 'missing' | 'blame'>, newest: number | null): string {
  const orders = src.blame() === 'orders';
  switch (src.state) {
    case 'ready': return '';
    case 'other-coin': return t('Liquidation levels are for BTC only for now.');
    case 'unavailable': return orders ? t('Stop levels could not be read.') : t('Liquidation levels could not be read.');
    case 'stale': return newest !== null ? t('Liquidation levels are out of date: the newest are from {time}.', { time: clock(newest) }) : t('Liquidation levels are loading.');
    case 'missing': {
      const why = src.missing();
      return why === 'proven' ? t('No proven traders list for this snapshot.') : why === 'groups' ? t('No trader groups for this snapshot yet.') : t('Stop levels are not ready yet.');
    }
    default: return orders ? t('Stop levels are loading.') : t('Liquidation levels are loading.');
  }
}

/**
 * The line under the map's legend (and the Liq tab's foot) while levels are drawn: what they are, whose, when the positions or orders
 * stood, the take profits' state, and whose data it is.
 */
export function liqNote(src: Pick<LiqLevelsSource, 'view' | 'takesState' | 'asOfs' | 'ordersOld'>, view: LiqView, at: number): string {
  const time = clock(at), group = view.group;
  const head = view.kind === 'stops' ? t('Hyperliquid stop orders at {time} · Powered by HyperTracker', { time })
    : view.kind === 'both'
      ? group === 'profitable' ? t('Profitable traders\' liquidations and all stops at {time} · Powered by HyperTracker', { time })
        : group === 'proven' ? t('Proven traders\' liquidations and all stops at {time} · Powered by HyperTracker', { time })
          : t('Hyperliquid liquidations and stops at {time} · Powered by HyperTracker', { time })
      : group === 'profitable' ? t('Profitable traders\' liquidation levels at {time} · Powered by HyperTracker', { time })
        : group === 'proven' ? t('Proven traders\' liquidation levels at {time} · Powered by HyperTracker', { time })
          : t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time });
  const parts = [head], orders = src.asOfs().orders;
  // The orders come from the newest snapshot an order file was read with: said when that is well behind the liquidations (or old).
  const old = orders !== null && view.kind !== 'stops' && src.ordersOld();
  if (old && view.kind === 'both') parts.push(view.takes ? t('stops and take profits as of {time}', { time: clock(orders) }) : t('stops as of {time}', { time: clock(orders) }));
  if (view.takes) {
    const state = src.takesState;
    parts.push(state === 'ready' ? (old && view.kind === 'liq' ? t('take profits as of {time}', { time: clock(orders) }) : t('with take profits'))
      : state === 'unavailable' ? t('take profits could not be read') : state === 'missing' ? t('take profits are not ready yet') : t('take profits are loading'));
  }
  return parts.join(' · ');
}
