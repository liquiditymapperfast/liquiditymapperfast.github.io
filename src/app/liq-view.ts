/**
 * What the levels show (Plus, 2026-11-17): one choice for the whole page, kept in `LiqLevelSettings` (`kind`, `takes`, `group`). The free view
 * is liquidations of all traders without take profits; every other choice is Plus. Without Plus the page draws the free view and keeps the
 * choice, which comes back with Plus (`effectiveView`). The stop and take-profit files have no trader groups, so the group is for
 * liquidations alone.
 */
import { t } from './i18n.ts';
import { plus } from './plus/pass.ts';
import type { LiqGroup, LiqKind, LiqLevelSettings } from './liq-url.ts';

export interface LiqView { kind: LiqKind; takes: boolean; group: LiqGroup }
/** What everyone sees without Plus. */
export const FREE_VIEW: LiqView = Object.freeze({ kind: 'liq', takes: false, group: 'all' });

/** Whether a choice is the free view (anything else is Plus). The group of a choice of stops alone counts for nothing. */
export const isFreeChoice = (v: Pick<LiqView, 'kind' | 'takes' | 'group'>): boolean => v.kind === 'liq' && !v.takes && v.group === 'all';
/** Whether the trader group applies to a kind: liquidations have groups, stops do not. */
export const groupApplies = (kind: LiqKind): boolean => kind !== 'stops';

/** What is drawn: the choice with Plus, the free view without it. A choice of stops alone has no group. */
export function effectiveView(s: Pick<LiqLevelSettings, 'kind' | 'takes' | 'group'>, plusOn: boolean): LiqView {
  if (!plusOn) return FREE_VIEW;
  return { kind: s.kind, takes: s.takes, group: groupApplies(s.kind) ? s.group : 'all' };
}

/** A saved Plus choice that is not drawn (no Plus here): the controls show it with a lock. */
export const heldBack = (s: Pick<LiqLevelSettings, 'kind' | 'takes' | 'group'>, plusOn: boolean): boolean => !plusOn && !isFreeChoice(effectiveView(s, true));

/** The same view, the same key: caches and snapshots of what is drawn are made again under another. */
export const viewKey = (v: LiqView): string => `${v.kind}|${groupApplies(v.kind) ? v.group : 'all'}|${v.takes ? 1 : 0}`;

/** A kind's short name, for a button and a menu. */
export function kindName(kind: LiqKind): string {
  return kind === 'stops' ? t('Stops') : kind === 'both' ? t('Liq + stops') : t('Liquidations');
}
/** A kind's name in a readout or a note. */
export function kindTitle(kind: LiqKind): string {
  return kind === 'stops' ? t('Stop levels') : kind === 'both' ? t('Liquidation and stop levels') : t('Liquidation levels');
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
 * What a view is called in a readout: its kind, then its group where one applies and is not everyone, then the take profits where they are
 * on ("Liquidation levels · Profitable traders · Take profits"), as parts joined by a middle dot.
 */
export function viewParts(v: LiqView): string[] {
  return [kindTitle(v.kind), ...(groupApplies(v.kind) && v.group !== 'all' ? [groupTitle(v.group)] : []), ...(v.takes ? [t('Take profits')] : [])];
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

/** What the page draws for these settings now. */
export const liveView = (s: Pick<LiqLevelSettings, 'kind' | 'takes' | 'group'>): LiqView => effectiveView(s, plusOn());
