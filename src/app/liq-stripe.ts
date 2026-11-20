/**
 * The liquidation stripe right of the live edge, apart from the pane that places it (panes/heat-pane.ts `#paintLiquidationLevels`): its lanes
 * painted from the source and, under a split, from the right set (`stripePlan`), each lane's rows kept from frame to frame by its set's key,
 * and what was painted, which is all the pane registers for its hover box and captions (`StripePainted`); and the words of the note under
 * the legend (`stripeNote`). The tests paint it on a recording context, so what they check is what the map draws.
 */
import { laneRows, paintLiqStripe, stripeLanes, type Lane, type LaneRows, type LiqLevelsSource, type LiqSet } from './liq-levels.ts';
import { splitLanes, type StripePlan } from './liq-split.ts';
import { groupTitle, narrowView, type LiqPair, type LiqView } from './liq-view.ts';
import { groupNoteParts, liqNote, liqWhy, ofGroup } from './liq-words.ts';
import { fitText } from './text-fit.ts';
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
    // Under a split every lane painted says what it holds (`stripePlan`): whose take profits, the liquidations' and the stops' lanes (whose,
    // where not everyone's), everyone's and the profitable traders' lanes, or everyone's levels alone beside a column too narrow to split. A
    // lane with nothing painted has no caption (the note under the legend says why).
    const [leftWords, rightWords] = plan.captions, left = painted.lanes;
    painted.captions = [
      ...(left?.takes && plan.takes ? [{ lane: left.takes, words: plan.takes, dashed: true }] : []),
      ...(left && leftWords ? [{ lane: left.levels, words: leftWords, dashed: false }] : []),
      ...(painted.right && rightWords ? [{ lane: painted.right.lane, words: rightWords, dashed: false }] : []),
    ];
  } else painted.takesLane = painted.lanes?.takes ?? null;
  return painted;
}

/**
 * The note under the legend while the levels are on (before the candles' warning): what they are, whose, when they stood and what is missing
 * (`liqNote`), or why nothing stands (`liqWhy`). Under a split of liquidations beside stops it says both, and when their orders stood.
 * Beside the profitable traders' lane (Sol, review 2026-11-19) it is composed from both sets drawn: everyone's note, its "as of" and, where
 * their lane has nothing, its reason named by group; then the profitable traders' own times and status (`groupNoteParts`), named too. Where
 * both groups' times agree and nothing is missing, it says what it said before.
 */
export function stripeNote(src: LiqLevelsSource, view: LiqView, pair: LiqPair | null, plan: StripePlan): string {
  const levels = src.levels, both = pair?.split === 'kinds' ? narrowView(pair) : null, ready = !!levels && src.state === 'ready', right = plan.two ? src.right : null;
  const why = (): string => liqWhy(src, src.asOfs().liq) || t('Liquidation levels are loading.');
  if (plan.standalone && right) {
    const all = groupTitle(view.group), head = levels && ready ? liqNote(src, view, levels.asOf, all) : ofGroup(all, why());
    return [head, ...groupNoteParts(right, ready ? src.asOfs() : { liq: null, orders: null })].join(' · ');
  }
  const said = both ? { ...src.setOf(both), takesState: src.takesState } : src;
  return levels && ready ? liqNote(said, both ?? view, levels.asOf) : why();
}

/**
 * The note's lines in `room` px (`measure` the width of words): whole parts (" · " between them) on each line as far as they go, then the
 * next line, at most `most` lines (the last holding the rest); a part wider than the room alone ends in "…". Two groups' times can need
 * more than the two lines the note used to have (the second line was cut short).
 */
export function noteLines(measure: (words: string) => number, note: string, room: number, most = 4): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of note.split(' · ')) {
    const next = line ? `${line} · ${part}` : part;
    if (!line || measure(next) <= room) line = next; else { lines.push(line); line = part; }
  }
  if (line) lines.push(line);
  if (lines.length > most) lines.splice(most - 1, lines.length, lines.slice(most - 1).join(' · '));
  return lines.map(l => fitText(measure, l, room));
}

/**
 * How many lines the note under the legend may take on a plot `ph` tall whose note starts at `under`: what leaves room below it, under the
 * line the "depth recorded from" note may take, for the stripe's captions (three at most, 17 px each), two at least (as the note always had)
 * and four at most (Sol, review 2026-11-19: on a 138 px phone map a four-line note pushed the last caption under the time axis).
 */
export function noteMostLines(ph: number, under: number): number {
  return Math.max(2, Math.min(4, Math.floor((ph - under - 13 - 3 - 3 * 17) / 13)));
}

/**
 * The note under the legend laid out in `room` px: its lines (`noteLines`, at most `noteMostLines`) and their top, `under` the legend or a
 * line lower where the "depth recorded from" note (`history`) stands there and the first line would run into it. Never down to `foot`, what
 * stands at the map's foot (the volume strip's names, `stripNamesTop`, or the plot's bottom): there it takes fewer lines, one at least (a
 * phone held sideways, 844 x 207, 2026-11-19: on its 138 px plot the second line ran under "Binance 15m candles"). Lines are 13 px apart and
 * 12 px tall; where even the first reaches the foot, the strip leaves the name under it out (`StripDraw.clear`).
 */
export function layNote(measure: (words: string) => number, note: string, room: number, o: { ph: number; under: number; foot: number; history: { x0: number; x1: number; top: number } | null }): { lines: string[]; top: number } {
  const topOf = (first: string): number => {
    const h = o.history, w = measure(first);
    return h && Math.abs(h.top - o.under) < 12 && h.x0 < 8 + w + 6 && h.x1 > 2 ? o.under + 13 : o.under;
  };
  let lines = noteLines(measure, note, room, noteMostLines(o.ph, o.under)), top = topOf(lines[0] ?? '');
  // Fewer lines make the first one longer, which can take it under the history note and a line lower: then it is fitted once more.
  for (let pass = 0; pass < 2; pass++) {
    const fit = Math.max(1, Math.floor((o.foot - top + 1) / 13));
    if (lines.length <= fit) break;
    lines = noteLines(measure, note, room, fit); top = topOf(lines[0] ?? '');
  }
  return { lines, top };
}
