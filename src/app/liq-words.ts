/**
 * The words Liquidation levels use wherever they are drawn (the map's stripe and column, the phone's Liq tab, the panel), by what is shown:
 * liquidation levels, stops, both added together, and the take profits beside them. Each a whole sentence or label of its own (`t()`), joined
 * by a middle dot where several are said together.
 */
import { t } from './i18n.ts';
import { clock, usd } from './format.ts';
import type { LevelsKind, LiqLevelsSource } from './liq-levels.ts';
import { groupApplies, groupTitle, type LiqView } from './liq-view.ts';

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
 * A total and its two parts in one unit and precision, the total's (`usd(total)`: whole dollars under $1,000, else tenths of K, M, B or T),
 * the parts rounded by largest remainder so the printed parts add up to the printed total. The total is what the parts add up to, or the
 * figure shown beside them, which they match but for rounding drift (two standings added in another order): each part is its share of the
 * printed total, which absorbs that drift. A part that is not a finite amount of at least nothing counts as nothing, so nothing prints
 * "NaN"; without a printable total (not finite), each is said alone.
 */
export function splitAmounts(total: number, a: number, b: number): [string, string, string] {
  const amount = (v: number): number => Number.isFinite(v) && v > 0 ? v : 0, pa = amount(a), pb = amount(b);
  const shown = usd(total), m = /^(\d+)(?:\.(\d))?([KMBT]?)$/.exec(shown);
  if (!m) return [shown, usd(pa), usd(pb)];
  const unit = m[3] ?? '', tenths = unit !== '';
  // The printed total in its steps (a dollar, or a tenth of its unit), and each part's share of them.
  const steps = Number(m[1]) * (tenths ? 10 : 1) + (tenths ? Number(m[2] ?? 0) : 0), sum = pa + pb;
  const xa = sum > 0 ? pa / sum * steps : 0, xb = sum > 0 ? steps - xa : 0;
  let na = Math.floor(xa), nb = Math.floor(xb);
  // The step the floors leave, if any, goes to the larger remainder, the first part's on a tie (parts of nothing stay nothing).
  if (sum > 0 && steps - na - nb > 0) { if (xa - na >= xb - nb) na++; else nb++; }
  const say = (n: number): string => n === 0 ? '0' : !tenths ? String(n) : `${Math.floor(n / 10)}${n % 10 ? `.${n % 10}` : ''}${unit}`;
  return [shown, say(na), say(nb)];
}

/**
 * A total of liquidations and stops (Liq + stops) with its two parts, wherever the page gives that total (the stripe's box, the column's
 * reading and its Mirror box, the Liq tab's finger): "Total $330.6M = liquidations $200.5M + stops $130.1M". `shown` is the figure the line
 * above says (the parts' sum when there is none), so the total is that figure as printed, and the parts add up to it (`splitAmounts`).
 */
export function splitText(parts: { liq: number; stops: number }, shown = parts.liq + parts.stops): string {
  const [total, liq, stops] = splitAmounts(shown, parts.liq, parts.stops);
  return t('Total {total} = liquidations {liq} + stops {stops}', { total: `$${total}`, liq: `$${liq}`, stops: `$${stops}` });
}

/** Said under the liquidation column's button (which names what its curve adds up) while take profits are shown. */
export const takesLeftOut = (): string => t('Take profits not included');

/**
 * The lines under the liquidation column's button, as part of its caption: whose liquidations, where a group is shown and the button had no
 * room for it (`groupOnButton` false: at 11 px the column's 128 px hold "Liquidations" but not "Liquidations · Profitable"), then that the take
 * profits are not in the curve while they show.
 */
export function columnNotes(view: LiqView, groupOnButton: boolean, takesShown: boolean): string[] {
  return [...(groupApplies(view.kind) && view.group !== 'all' && !groupOnButton ? [groupTitle(view.group)] : []), ...(takesShown ? [takesLeftOut()] : [])];
}
/** What the curve adds up and leaves out, for a newcomer: in the help, the Guide and the column's tip while take profits show. */
export const curveSentence = (): string => t('The curve totals the selected liquidations and/or stops. Take profits are shown separately.');

/**
 * Why nothing of the view is drawn (the column, the Liq tab), or '' when it is: loading, not read, out of date, or not in the snapshot (no
 * groups or stops there yet). A view of both says which part is missing.
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
      return why === 'groups' ? t('No trader groups for this snapshot yet.') : t('Stop levels are not ready yet.');
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
        : t('Hyperliquid liquidations and stops at {time} · Powered by HyperTracker', { time })
      : group === 'profitable' ? t('Profitable traders\' liquidation levels at {time} · Powered by HyperTracker', { time })
        : t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time });
  const parts = [head], orders = src.asOfs().orders;
  // The orders come from the newest snapshot an order file was read with: said when that is well behind the liquidations (or old).
  const old = orders !== null && view.kind !== 'stops' && src.ordersOld();
  if (old && view.kind === 'both') parts.push(view.takes ? t('stops and take profits as of {time}', { time: clock(orders) }) : t('stops as of {time}', { time: clock(orders) }));
  if (view.takes) {
    const state = src.takesState;
    // Both with old orders has said when the take profits are from already ("stops and take profits as of").
    if (state === 'ready') { if (!(old && view.kind === 'both')) parts.push(old && view.kind === 'liq' ? t('take profits as of {time}', { time: clock(orders) }) : t('with take profits')); }
    else parts.push(state === 'unavailable' ? t('take profits could not be read') : state === 'missing' ? t('take profits are not ready yet') : t('take profits are loading'));
  }
  return parts.join(' · ');
}
