/**
 * What the levels show, as a menu (the map's liquidation column heading, the phone's Liq tab) and as the Liq levels panel's rows: Show
 * (liquidations, stops, both), Take profits, and Traders (all, or the profitable traders: liquidations only). Every choice but the free view is
 * Plus: without Plus such a choice is marked with a lock and pressing it opens the Plus panel, the setting unchanged; the saved choice is
 * shown (it comes back with Plus) while the page draws the free view.
 */
import type { Store } from './store.ts';
import { t } from './i18n.ts';
import { openMenu, type MenuItem } from './menu.ts';
import { showGuide } from './help.ts';
import { PLUS_NAME } from './plus/name.ts';
import { togglePlus } from './plus/panel.ts';
import { LIQ_GROUPS, LIQ_KINDS, type LiqGroup, type LiqKind, type LiqLevelSettings } from './liq-url.ts';
import { groupName, kindName, plusOn } from './liq-view.ts';

/** The Guide's section on liquidation levels, stops and take profits. */
export const LIQ_KINDS_GUIDE = 'liq-kinds';

/** A change of the choice, and whether it is part of Plus (anything that is not back towards the free view). */
export type LiqChange = { kind: LiqKind } | { group: LiqGroup } | { takes: boolean };
export const isPlusChange = (c: LiqChange): boolean => 'kind' in c ? c.kind !== 'liq' : 'group' in c ? c.group !== 'all' : c.takes;

/**
 * Make a change, or, where it is part of Plus and this browser has no Plus, open the Plus panel by `anchor` and leave the setting as it is.
 * Returns whether the setting changed.
 */
export function chooseLiq(store: Store, change: LiqChange, anchor: HTMLElement): boolean {
  if (isPlusChange(change) && !plusOn()) { togglePlus(anchor); return false; }
  store.set({ liqLevels: { ...store.state.liqLevels, ...change } });
  return true;
}

/** Why the trader choice does nothing while stops alone are shown. */
export const noGroupsTip = (): string => t('Stops have no trader groups: the choice is for liquidations.');

/** The menu's rows for the saved choice `s`, a lock on each Plus choice while there is no Plus here. */
export function liqMenuItems(s: Pick<LiqLevelSettings, 'kind' | 'takes' | 'group'>, member: boolean): MenuItem[] {
  const plus = (paid: boolean): Pick<MenuItem, 'tag' | 'locked'> => paid ? { tag: PLUS_NAME, locked: !member } : {};
  const stopsOnly = s.kind === 'stops';
  return [
    { id: 'h:show', label: t('Show'), heading: true },
    ...LIQ_KINDS.map((kind): MenuItem => ({ id: `kind:${kind}`, label: kindName(kind), checked: s.kind === kind, ...plus(kind !== 'liq') })),
    { id: 'takes', label: t('Take profits'), checked: s.takes, ...plus(true), tip: t('Take-profit orders as a layer of their own beside the levels: the sells that close longs above the price, the buys that close shorts below it.') },
    { id: 'h:traders', label: t('Traders'), heading: true, ...(stopsOnly ? { tip: noGroupsTip() } : {}) },
    ...(stopsOnly ? [{ id: 'h:no-groups', label: t('Stops have no trader groups.'), heading: true }] : []),
    ...LIQ_GROUPS.map((group): MenuItem => ({ id: `group:${group}`, label: groupName(group), checked: s.group === group, disabled: stopsOnly, ...plus(group !== 'all') })),
    { id: 'guide', label: t('What these are'), action: true },
  ];
}

/** The change a menu row asks for, or null (a heading, the Guide). */
export function changeOf(id: string, s: Pick<LiqLevelSettings, 'takes'>): LiqChange | null {
  const [what, value] = id.split(':');
  if (what === 'kind' && (LIQ_KINDS as readonly string[]).includes(value ?? '')) return { kind: value as LiqKind };
  if (what === 'group' && (LIQ_GROUPS as readonly string[]).includes(value ?? '')) return { group: value as LiqGroup };
  if (what === 'takes') return { takes: !s.takes };
  return null;
}

/** Open the menu by `anchor`. */
export function openLiqMenu(anchor: HTMLElement, store: Store, align: 'left' | 'right' = 'left'): { close(): void } {
  const s = store.state.liqLevels;
  return openMenu(anchor, liqMenuItems(s, plusOn()), '', {
    onPreview: () => {},
    onSelect: id => {
      if (id === 'guide') { showGuide(LIQ_KINDS_GUIDE); return; }
      const change = changeOf(id, store.state.liqLevels);
      if (change) chooseLiq(store, change, anchor);
    },
  }, align, { title: t('What the levels show') });
}
