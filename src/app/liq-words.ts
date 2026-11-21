/**
 * The words Liquidation levels use wherever they are drawn (the map's stripe and column, the phone's Liq tab, the panel), by what is shown:
 * liquidation levels, stops, both added together, and the take profits beside them. Each a whole sentence or label of its own (`t()`), joined
 * by a middle dot where several are said together.
 */
import { t } from './i18n.ts';
import { clock, usd } from './format.ts';
import type { LevelsKind, LiqLevelsSource, LiqSet } from './liq-levels.ts';
import type { LiqFamily } from './liq-history.ts';
import { curveOf, groupName, groupTitle, kindName, kindTitle, takesBeside, type LiqPair, type LiqView } from './liq-view.ts';
import type { LiqSplit } from './liq-url.ts';

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

/**
 * Said where the profitable traders' stops or take profits are part of the view but their file is not there (the server has none yet, or not
 * for this snapshot): nothing is drawn for them, never everyone's orders under their name.
 */
export const ordersAbsent = (): string => t('+PnL traders\' stops and take profits are not available yet.');

/**
 * Why the levels' history draws nothing where a file it needs could not be read (a rollup refused whole, or not reached): the part named as the
 * live column names it (`liqWhy`), the orders by what the view shows of them.
 */
export function readFailed(family: LiqFamily, view: Pick<LiqView, 'stops'>): string {
  return family === 'orders' || family === 'orderGroups' ? (view.stops ? t('Stop levels could not be read.') : t('Take-profit levels could not be read.')) : t('Liquidation levels could not be read.');
}

/** Said under the liquidation column's button (which names what its curve adds up) while take profits are shown. */
export const takesLeftOut = (): string => t('Take profits not included');

/**
 * The lines under the liquidation column's button, as part of its caption: whose liquidations, where a group is shown and the button had no
 * room for it (`groupOnButton` false: at 11 px the column's 128 px hold "Liquidations" but not "Liquidations · Profitable"), then that the take
 * profits are not in the curve while they show.
 */
export function columnNotes(view: LiqView, groupOnButton: boolean, takesShown: boolean, absent = false): string[] {
  return [...(view.group !== 'all' && !groupOnButton ? [groupTitle(view.group)] : []), ...(takesShown ? [takesLeftOut()] : []), ...(absent ? [ordersAbsent()] : [])];
}
/** What the curve adds up and leaves out, for a newcomer: in the levels control, the help and the column's tip while take profits show. */
export const curveSentence = (): string => t('The curve totals the liquidations and stops that are on. Take profits are dashed bars beside it, or, on alone, a dashed curve of their own.');

/**
 * Why nothing of the view is drawn (the column, the Liq tab), or '' when it is: loading, not read, out of date, or not in the snapshot (no
 * groups or stops there yet). A view of both says which part is missing.
 */
export function liqWhy(src: Pick<LiqLevelsSource, 'state' | 'view' | 'levels' | 'missing' | 'blame'>, newest: number | null): string {
  // The order file's part is named by what the view draws of it: take profits on alone, else stops.
  const orders = src.blame() === 'orders', takes = orders && curveOf(src.view) === 'takes';
  switch (src.state) {
    case 'ready': return '';
    case 'other-coin': return t('Liquidation levels are for BTC only for now.');
    case 'unavailable': return takes ? t('Take-profit levels could not be read.') : orders ? t('Stop levels could not be read.') : t('Liquidation levels could not be read.');
    case 'stale': return newest !== null ? t('Liquidation levels are out of date: the newest are from {time}.', { time: clock(newest) }) : t('Liquidation levels are loading.');
    case 'missing': {
      const why = src.missing();
      return why === 'groups' ? t('No trader groups for this snapshot yet.') : why === 'profitable-orders' ? ordersAbsent() : takes ? t('Take-profit levels are not ready yet.') : t('Stop levels are not ready yet.');
    }
    default: return takes ? t('Take-profit levels are loading.') : orders ? t('Stop levels are loading.') : t('Liquidation levels are loading.');
  }
}

/** A part of the note said of one group ("Profitable traders: stops as of 14:00"), where two groups' lanes stand side by side. */
export const ofGroup = (who: string, what: string): string => t('{who}: {what}', { who, what });

/**
 * The line under the map's legend (and the Liq tab's foot) while levels are drawn: what they are, whose, when the positions or orders
 * stood, the take profits' state (beside the curve), and whose data it is. `who` names whose orders an "as of" is (`ofGroup`), where
 * another group's lane stands beside these (everyone beside the profitable traders); without it the note is as it always was.
 */
export function liqNote(src: Pick<LiqLevelsSource, 'view' | 'takesState' | 'asOfs' | 'ordersOld' | 'ordersAbsent'>, view: LiqView, at: number, who?: string): string {
  const named = (part: string): string => who ? ofGroup(who, part) : part;
  const time = clock(at), group = view.group, curve = curveOf(view), beside = takesBeside(view);
  const mine = group === 'profitable';
  const head = curve === 'takes' ? mine ? t('+PnL traders\' take-profit orders at {time} · Powered by HyperTracker', { time }) : t('Hyperliquid take-profit orders at {time} · Powered by HyperTracker', { time })
    : curve === 'stops' ? mine ? t('+PnL traders\' stop orders at {time} · Powered by HyperTracker', { time }) : t('Hyperliquid stop orders at {time} · Powered by HyperTracker', { time })
    : curve === 'both'
      ? mine ? t('+PnL traders\' liquidations and stops at {time} · Powered by HyperTracker', { time })
        : t('Hyperliquid liquidations and stops at {time} · Powered by HyperTracker', { time })
      : group === 'profitable' ? t('+PnL traders\' liquidation levels at {time} · Powered by HyperTracker', { time })
        : t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time });
  const parts = [head], orders = src.asOfs().orders, absent = src.ordersAbsent();
  // The profitable traders' orders the view asks for are not there: said, and nothing drawn for them.
  if (absent) parts.push(ordersAbsent());
  // The orders come from the newest snapshot an order file was read with: said when that is well behind the liquidations (or old).
  const old = orders !== null && view.liq && src.ordersOld();
  if (old && curve === 'both') parts.push(named(beside ? t('stops and take profits as of {time}', { time: clock(orders) }) : t('stops as of {time}', { time: clock(orders) })));
  if (beside && !absent) {
    const state = src.takesState;
    // Both with old orders has said when the take profits are from already ("stops and take profits as of").
    if (state === 'ready') { if (!(old && curve === 'both')) parts.push(old && curve === 'liq' ? named(t('take profits as of {time}', { time: clock(orders) })) : t('with take profits')); }
    else parts.push(state === 'unavailable' ? t('take profits could not be read') : state === 'missing' ? t('take profits are not ready yet') : t('take profits are loading'));
  }
  return parts.join(' · ');
}

/**
 * What the note says of a split's right set beside the left set's note (the profitable traders' lane beside everyone's), each part named by
 * its group (`ofGroup`): their stops and take profits not on the server (`ordersAbsent`, which names them); why their lane draws nothing;
 * and, where it draws, when their positions and their stops stood wherever that is not what the left part says (`left`, the left set's
 * times as its note states them, null where it states none) or their stops are old (Sol, review 2026-11-19: their orders hours old drew with
 * no word of it). Nothing where both groups' times agree: the left part says them.
 */
export function groupNoteParts(right: Pick<LiqSet, 'state' | 'view' | 'levels' | 'missing' | 'blame' | 'asOfs' | 'ordersOld' | 'ordersAbsent'>, left: { liq: number | null; orders: number | null }): string[] {
  const named = (what: string): string => ofGroup(groupTitle(right.view.group), what), absent = right.ordersAbsent(), parts = absent ? [ordersAbsent()] : [];
  if (!right.levels || right.state !== 'ready') return absent ? parts : [...parts, named(liqWhy(right, right.asOfs().liq) || t('Liquidation levels are loading.'))];
  const at = right.asOfs();
  if (at.liq !== null && at.liq !== left.liq) parts.push(named(t('positions as of {time}', { time: clock(at.liq) })));
  if (at.orders !== null && (right.ordersOld() || at.orders !== left.orders)) parts.push(named(t('stops as of {time}', { time: clock(at.orders) })));
  return parts;
}

/** A split's name on the column's button and the Liq tab's title: its left column | its right one. */
export function splitName(split: Exclude<LiqSplit, 'none'>): string {
  return split === 'kinds' ? t('Liq | Stops') : t('Everyone | +PnL');
}
/** A split's name in the levels control's Split choice. */
export function splitChoiceName(split: LiqSplit): string {
  return split === 'kinds' ? t('Liquidations | Stops') : split === 'groups' ? t('Everyone | +PnL') : t('None');
}
/** What heads each sub-column of a split: the kind (liquidations, stops), or whose levels they are (everyone, the profitable traders). */
export function subNames(p: LiqPair): [string, string] {
  return p.split === 'kinds' ? [kindName('liq'), kindName('stops')] : [groupName('all'), groupName('profitable')];
}
/**
 * The levels control's live line under a split: what each column holds, then what both share ("Left: Liquidations · Right: Stops ·
 * Profitable", "Left: Everyone · Right: Profitable · Curve: Liq + stops · TP bars on the left").
 */
export function pairSummary(p: LiqPair): string {
  const [left, right] = subNames(p);
  return [t('Left: {what}', { what: left }), t('Right: {what}', { what: right }),
    ...(p.split === 'groups' ? [t('Curve: {what}', { what: kindName(curveOf(p.left)) })] : []),
    ...(takesBeside(p.left) ? [t('TP bars on the left')] : []),
    ...(p.split === 'kinds' && p.left.group !== 'all' ? [groupName(p.left.group)] : [])].join(' · ');
}
/** Everything a split draws, in words, for the button's tip and a screen reader. */
export function pairDescription(p: LiqPair): string {
  const left = p.split === 'kinds' ? kindTitle('liq') : groupTitle('all'), right = p.split === 'kinds' ? kindTitle('stops') : groupTitle('profitable');
  return [t('Left column: {what}.', { what: left }), t('Right column: {what}.', { what: right }),
    ...(p.split === 'groups' ? [t('Curve: {what}.', { what: kindTitle(curveOf(p.left)) })] : []),
    ...(takesBeside(p.left) ? [t('Take-profit bars shown on the left.')] : []),
    ...(p.split === 'kinds' ? [t('Traders: {who}.', { who: groupName(p.left.group) })] : [])].join(' ');
}
/**
 * Said under the column's button (or on the Liq tab) when a split has no room for its two columns: that, and what is drawn instead
 * ("Too narrow to split: Liq + stops"). Liquidations beside stops fall back to the two added up, as with no split; everyone beside the
 * profitable traders to everyone's.
 */
export const narrowNote = (what: string): string => t('Too narrow to split: {what}', { what });
/** The take profits' caption on the stripe under a split: whose they are. */
export const takesOf = (group: LiqView['group']): string => `${t('Take profits')} · ${groupName(group)}`;
