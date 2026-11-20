/**
 * What the levels show (Plus, 2026-11-17; three switches since 2026-11-19): one choice for the whole page, kept in `LiqLevelSettings`
 * (`liq`, `stops`, `takes`, at least one on, `group`, and `split`). The free view is liquidations of all traders; every other choice is Plus.
 * Without Plus the page draws the free view and keeps the choice, which comes back with Plus (`effectiveView`). The group is every kind's:
 * the profitable traders' liquidations, stops and take profits each come from files of their own, never everyone's under their name.
 *
 * A split (2026-11-19) draws the liquidation column as two sub-columns (`splitPair`): liquidations beside stops, or everyone beside the
 * profitable traders. The stripe gives each column a lane of its own beside a drawn split (liq-split.ts `stripePlan`). Everywhere else that
 * draws one series (the stripe beside a column too narrow to split everyone beside the profitable traders, such a column itself, a phone's
 * strip) draws the left column's set (`effectiveView`): the page's one series. The Depth pane is not split at all: it draws the choice as with
 * no split (`depthView`, owner's rule of 2026-11-20).
 */
import { t } from './i18n.ts';
import { plus } from './plus/pass.ts';
import { splitFor, type LiqGroup, type LiqLevelSettings, type LiqSplit } from './liq-url.ts';

export interface LiqView { liq: boolean; stops: boolean; takes: boolean; group: LiqGroup }
/** The parts of the setting a view is made of (a choice from before the split reads as none). */
export type LiqChoice = Pick<LiqLevelSettings, 'liq' | 'stops' | 'takes' | 'group'> & { split?: LiqSplit };
/** What everyone sees without Plus. */
export const FREE_VIEW: LiqView = Object.freeze({ liq: true, stops: false, takes: false, group: 'all' });

/** The split a choice draws: none without Plus, else the saved one where its kinds allow it (`splitFor`). */
export const effectiveSplit = (s: LiqChoice, plusOn: boolean): LiqSplit => plusOn ? splitFor(s.split ?? 'none', s) : 'none';

/**
 * The two sub-columns of a split: liquidations then stops, both of the chosen traders (take profits go with the left one); or everyone's
 * then the profitable traders', both of the chosen kinds (take profits with the left one, everyone's). Null where nothing is split.
 */
export interface LiqPair { split: Exclude<LiqSplit, 'none'>; left: LiqView; right: LiqView }
export function splitPair(s: LiqChoice, plusOn: boolean): LiqPair | null {
  const split = effectiveSplit(s, plusOn);
  if (split === 'kinds') return { split, left: { liq: true, stops: false, takes: s.takes, group: s.group }, right: { liq: false, stops: true, takes: false, group: s.group } };
  if (split === 'groups') return { split, left: { liq: s.liq, stops: s.stops, takes: s.takes, group: 'all' }, right: { liq: s.liq, stops: s.stops, takes: false, group: 'profitable' } };
  return null;
}
/**
 * What a split draws where it has no room for its two columns (a narrow map, a narrow Liq tab): as with no split, liquidations and stops added
 * up, for liquidations beside stops; everyone's chosen kinds for everyone beside the profitable traders (the saved Traders value is not
 * drawn, nor written: it waits for the split to go back to none). Never anything that is switched on left out.
 */
export function narrowView(p: LiqPair): LiqView {
  return p.split === 'kinds' ? { liq: true, stops: true, takes: p.left.takes, group: p.left.group } : p.left;
}
/** The same pair, the same key. */
export const pairKey = (p: LiqPair | null): string => p ? `${p.split}|${viewKey(p.left)}|${viewKey(p.right)}` : '';

/**
 * What the curve adds up (the same names as `LevelsKind` in liq-levels.ts): the liquidations, the stops, both (Liq + stops), or the take
 * profits, which have a curve only when they are on alone; with liquidations or stops they are bars of their own beside it (`takesBeside`).
 */
export type LiqCurve = 'liq' | 'stops' | 'both' | 'takes';
export const curveOf = (v: Pick<LiqView, 'liq' | 'stops'>): LiqCurve => v.liq && v.stops ? 'both' : v.liq ? 'liq' : v.stops ? 'stops' : 'takes';
/** Whether take profits are drawn beside the curve as bars of their own: on with liquidations or stops (alone they are the curve). */
export const takesBeside = (v: Pick<LiqView, 'liq' | 'stops' | 'takes'>): boolean => v.takes && (v.liq || v.stops);
/** Whether the view needs the stop and take-profit file: stops or take profits are on. */
export const ordersShown = (v: Pick<LiqView, 'stops' | 'takes'>): boolean => v.stops || v.takes;

/** Whether a choice is the free view (anything else is Plus, a split included). */
export const isFreeChoice = (v: LiqChoice): boolean => v.liq && !v.stops && !v.takes && v.group === 'all' && splitFor(v.split ?? 'none', v) === 'none';

/**
 * What is drawn as one series: the choice with Plus, the free view without it; under a split, the left column's set (`splitPair`), which a
 * column too narrow to split and the stripe's left lane draw (its only lane beside such a column under everyone beside the profitable
 * traders). Not the Depth pane's: `depthView`.
 */
export function effectiveView(s: LiqChoice, plusOn: boolean): LiqView {
  if (!plusOn) return FREE_VIEW;
  return splitPair(s, plusOn)?.left ?? { liq: s.liq, stops: s.stops, takes: s.takes, group: s.group };
}

/**
 * What the Depth pane draws (owner's rule, 2026-11-20): Split is the liquidation column's and the stripe's choice, never the Depth pane's, which
 * draws the choice as with no split: Liquidations | Stops as Liq + stops (the kinds that are on, of the chosen traders), and Everyone |
 * Profitable as everyone's levels of the chosen kinds (the saved Traders value is not drawn, nor written). Only the split in force counts: one
 * kept while a kind it needs is off draws as none. The free view without Plus. Its bands, header, table, Range summary and levels button follow it.
 */
export function depthView(s: LiqChoice, plusOn: boolean): LiqView {
  if (!plusOn) return FREE_VIEW;
  return { liq: s.liq, stops: s.stops, takes: s.takes, group: effectiveSplit(s, plusOn) === 'groups' ? 'all' : s.group };
}

/** A saved Plus choice that is not drawn (no Plus here): the controls say it is kept and comes back with Plus. */
export const heldBack = (s: LiqChoice, plusOn: boolean): boolean => !plusOn && !isFreeChoice(s);

/** The same view, the same key: caches and snapshots of what is drawn are made again under another. */
export const viewKey = (v: LiqView): string => `${v.liq ? 1 : 0}${v.stops ? 1 : 0}${v.takes ? 1 : 0}|${v.group}`;

/** What the curve adds up, as the column's button and the levels control say it. */
export function kindName(curve: LiqCurve): string {
  return curve === 'stops' ? t('Stops') : curve === 'both' ? t('Liq + stops') : curve === 'takes' ? t('Take profits') : t('Liquidations');
}
/** The same in a readout or a note. */
export function kindTitle(curve: LiqCurve): string {
  return curve === 'stops' ? t('Stop levels') : curve === 'both' ? t('Liquidation and stop levels') : curve === 'takes' ? t('Take-profit levels') : t('Liquidation levels');
}
/** A group's short name, for a button and a menu. */
export function groupName(group: LiqGroup): string {
  // Everyone, not All: the word for all traders agrees with the traders in every language (French Tous, not the feminine Toutes of All).
  return group === 'profitable' ? t('Profitable') : t('Everyone');
}
/** A group's name in a readout or a note. */
export function groupTitle(group: LiqGroup): string {
  return group === 'profitable' ? t('Profitable traders') : t('All traders');
}

/**
 * What a view is called in a readout: what its curve adds up, then its group where one applies and is not everyone, then the take profits
 * where they are drawn beside the curve ("Liquidation levels · Profitable traders · Take profits"), as parts joined by a middle dot.
 */
export function viewParts(v: LiqView): string[] {
  return [kindTitle(curveOf(v)), ...(v.group !== 'all' ? [groupTitle(v.group)] : []), ...(takesBeside(v) ? [t('Take profits')] : [])];
}

/** The levels control's live line: what the curve adds up, the take-profit bars beside it, whose ("Curve: Liq + stops · TP bars · Profitable"). */
export function levelsSummary(v: LiqView): string {
  return [t('Curve: {what}', { what: kindName(curveOf(v)) }), ...(takesBeside(v) ? [t('TP bars')] : []), ...(v.group !== 'all' ? [groupName(v.group)] : [])].join(' · ');
}
/** Everything a view draws, in words, for a tip and an accessible description ("Curve: Liquidation and stop levels. Take-profit bars shown. Traders: Everyone."). */
export function levelsDescription(v: LiqView): string {
  return [t('Curve: {what}.', { what: kindTitle(curveOf(v)) }), ...(takesBeside(v) ? [t('Take-profit bars shown.')] : []), t('Traders: {who}.', { who: groupName(v.group) })].join(' ');
}

let plusOnHeld: boolean | null = null;
// Told before any pane is (they import this module): a pane told of a change reads the new value, never the one before it.
plus().subscribe(() => { plusOnHeld = null; });
/**
 * Whether Plus is in force in this browser, kept from the membership's own announcements (`plus().on` reads the pass each time it is asked,
 * too much for every frame). A pass that runs out unannounced is told within a minute (`Plus.tick`).
 */
export function plusOn(): boolean {
  plusOnHeld ??= plus().on;
  return plusOnHeld;
}

/** What the page draws for these settings now, as one series (the left column's set under a split). */
export const liveView = (s: LiqChoice): LiqView => effectiveView(s, plusOn());
/** What the Depth pane draws for these settings now (`depthView`). */
export const liveDepthView = (s: LiqChoice): LiqView => depthView(s, plusOn());
/** The split the page draws for these settings now, where the room allows it, or null. */
export const liveSplit = (s: LiqChoice): LiqPair | null => splitPair(s, plusOn());
/**
 * What the levels' source is asked to keep fresh for these settings now: the one series (`liveView`) and a split's right column, or null.
 * Every pane that asks (the map, the phone's Liq tab) asks through here, so they always ask for the same and never take turns changing it.
 */
export const liveAsk = (s: LiqChoice): { view: LiqView; right: LiqView | null } => ({ view: liveView(s), right: liveSplit(s)?.right ?? null });
