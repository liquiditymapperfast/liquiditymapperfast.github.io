/**
 * The liquidation stripe right of the live edge, apart from the pane that places it (panes/heat-pane.ts `#paintLiquidationLevels`): its lanes
 * painted from the source and, under a split, from the right set (`stripePlan`), each lane's rows kept from frame to frame by its set's key,
 * and what was painted, which is all the pane registers for its hover box and captions (`StripePainted`); and the words of the note under
 * the legend (`stripeNote`). The tests paint it on a recording context, so what they check is what the map draws.
 */
import { laneRows, paintLiqStripe, stripeLanes, type Lane, type LaneRows, type LiqLevelsSource, type LiqSet } from './liq-levels.ts';
import { splitLanes, type StripePlan } from './liq-split.ts';
import { narrowView, type LiqPair, type LiqView } from './liq-view.ts';
import { liqNote, liqWhy, ordersAbsent } from './liq-words.ts';
import { t } from './i18n.ts';
import type { View } from './view.ts';

/** Each lane's rows as last painted (the levels', the take profits', a split's right set's), kept while their keys hold (`laneRows`). */
export interface StripeHeld { levels: LaneRows | null; takes: LaneRows | null; right: LaneRows | null }
/** The colours the stripe is painted in (the pane's palette). */
export interface StripeColors { candleUp: string; candleDown: string; text: string; muted: string; bg: string }
/** A caption over a lane: its words and whether its sample is dashed (take profits). */
export interface LaneCaption { lane: Lane; words: string; dashed: boolean }
/**
 * What the stripe painted this frame: the left set's lanes (the levels' and the take profits'), with the group each reading names; a split's
 * right lane with the set it was painted from; the captions under a split; and, without one, the take profits' lane for their own caption.
 */
export interface StripePainted {
  lanes: { levels: Lane; takes: Lane | null; whose: string | null; takesWhose: string | null } | null;
  right: { lane: Lane; set: LiqSet; whose: string | null } | null;
  captions: LaneCaption[] | null;
  takesLane: Lane | null;
}

/** Whether the stripe stands this frame: the left set ready, or (everyone beside the profitable traders) the right set drawn on its own. */
export function stripeStands(src: LiqLevelsSource, plan: StripePlan): boolean {
  const right = plan.two ? src.right : null;
  return (!!src.levels && src.state === 'ready') || (plan.standalone && !!right?.levels && right.state === 'ready');
}

/**
 * Paints the stripe from the live edge `x0` to the plot's right edge `pw` and says what it painted, or null where nothing stands or the live
 * edge leaves no room. The take profits are a lane of their own by the live edge, dashed, never added to the levels (they sit on the other side
 * of the price); the levels' lane is the one beside the liquidation column, whose curve sums them. A split drawn as two lanes: the left set's
 * lane, then the right set's beside the column, in the column's order. `held` keeps each lane's rows from frame to frame (updated in place).
 */
export function paintStripe(ctx: CanvasRenderingContext2D, o: { src: LiqLevelsSource; plan: StripePlan; pair: LiqPair | null; x0: number; pw: number; ph: number; view: View; colors: StripeColors; held: StripeHeld }): StripePainted | null {
  const { src, plan, pair, x0, pw, ph, view: v, colors: p, held } = o;
  if (!stripeStands(src, plan) || x0 >= pw - 8) return null;
  const levels = src.levels, leftReady = !!levels && src.state === 'ready', right = plan.two ? src.right : null, rightReady = !!right?.levels && right.state === 'ready';
  const takes = leftReady && src.takesState === 'ready' ? src.takes : null;
  const lanes: { levels: Lane; takes: Lane | null; right: Lane | null } = plan.two ? (({ left, takes: tl, right: rl }) => ({ levels: left, takes: tl, right: rl }))(splitLanes(x0, pw, !!takes)) : { ...stripeLanes(x0, pw, !!takes), right: null };
  const painted: StripePainted = { lanes: null, right: null, captions: null, takesLane: null };
  if (levels && leftReady) {
    const { rows, heat } = held.levels = laneRows(src, 'levels', levels, v, ph, held.levels);
    // Take profits on alone are the levels: drawn as they are beside the others (dashed, buys below in the rising colour), the full width.
    const alone = levels.kind === 'takes';
    paintLiqStripe(ctx, v, lanes.levels.x0, lanes.levels.x1, ph, rows, heat, alone ? { long: p.candleUp, short: p.candleDown, text: p.text, muted: p.muted, bg: p.bg }
      : { long: p.candleDown, short: p.candleUp, text: p.text, muted: p.muted, bg: p.bg }, alone);
    if (takes && lanes.takes) {
      const tk = held.takes = laneRows(src, 'takes', takes, v, ph, held.takes);
      // By what the orders do: the take profits of shorts are buys (below the price, the rising colour), those of longs sells.
      paintLiqStripe(ctx, v, lanes.takes.x0, lanes.takes.x1, ph, tk.rows, tk.heat, { long: p.candleUp, short: p.candleDown, text: p.text, muted: p.muted, bg: p.bg }, true);
    }
    painted.lanes = { levels: lanes.levels, takes: lanes.takes, whose: plan.whose[0], takesWhose: plan.takesWhose };
  }
  // The right lane, from its own set, on its own colour scale; its rows kept by the set's key, which names its view (its group) and the
  // family of its orders, so a lane of one group never shows another's rows.
  if (lanes.right && right?.levels && rightReady) {
    const rr = held.right = laneRows({ key: () => right.key(), takesKey: () => '', taken: () => right.taken(), takesTaken: () => null }, 'levels', right.levels, v, ph, held.right);
    paintLiqStripe(ctx, v, lanes.right.x0, lanes.right.x1, ph, rr.rows, rr.heat, { long: p.candleDown, short: p.candleUp, text: p.text, muted: p.muted, bg: p.bg }, false);
    painted.right = { lane: lanes.right, set: right, whose: plan.whose[1] };
  }
  if (pair) {
    // Under a split every lane says what it holds (`stripePlan`): whose take profits, the liquidations' and the stops' lanes (whose, where
    // not everyone's), everyone's and the profitable traders' lanes, or everyone's levels alone beside a column too narrow to split.
    const [leftWords, rightWords] = plan.captions;
    painted.captions = [
      ...(lanes.takes && plan.takes ? [{ lane: lanes.takes, words: plan.takes, dashed: true }] : []),
      ...(leftWords ? [{ lane: lanes.levels, words: leftWords, dashed: false }] : []),
      ...(lanes.right && rightWords && (plan.standalone || painted.right) ? [{ lane: lanes.right, words: rightWords, dashed: false }] : []),
    ];
  } else painted.takesLane = lanes.takes;
  return painted;
}

/**
 * The note under the legend while the levels are on (before the candles' warning): what they are, whose, when they stood and what is missing
 * (`liqNote`), or why nothing stands (`liqWhy`). Under a split of liquidations beside stops it says both, and when their orders stood; beside
 * the profitable traders' lane, that their stops and take profits are not on the server, as the sub-column says it under its button.
 */
export function stripeNote(src: LiqLevelsSource, view: LiqView, pair: LiqPair | null, plan: StripePlan): string {
  const levels = src.levels, both = pair?.split === 'kinds' ? narrowView(pair) : null;
  const said = both ? { ...src.setOf(both), takesState: src.takesState } : src;
  const note = levels && src.state === 'ready' ? liqNote(said, both ?? view, levels.asOf) : liqWhy(src, src.asOfs().liq) || t('Liquidation levels are loading.');
  const right = plan.two ? src.right : null;
  return plan.standalone && right?.ordersAbsent() ? `${note} · ${ordersAbsent()}` : note;
}
