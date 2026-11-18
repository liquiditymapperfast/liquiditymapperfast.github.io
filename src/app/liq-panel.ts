import type { Store } from './store.ts';
import { heading, note, openedPanel, segmented, switchRow } from './ui.ts';
import { HELP, helpButton } from './help.ts';
import { t } from './i18n.ts';
import { el } from './dom.ts';
import type { LiqLevelsSource } from './liq-levels.ts';
import { LIQ_GROUPS, LIQ_KINDS, type LiqLevelSettings } from './liq-url.ts';
import { replaying } from './replay/clock.ts';
import { groupName, heldBack, kindName, liveView, plusOn } from './liq-view.ts';
import { chooseLiq, noGroupsTip, type LiqChange } from './liq-menu.ts';
import { liqNote, liqWhy } from './liq-words.ts';
import { PLUS_NAME } from './plus/name.ts';

/** The small Plus tag on a choice that is part of Plus, with a lock while this browser has no Plus. */
const plusTag = (member: boolean): HTMLElement => el('span', { class: member ? 'plus-tag' : 'plus-tag locked', textContent: PLUS_NAME });

/**
 * The Liquidation levels panel: its first row switches them on and off, the second their own column beside the profile column; then what
 * they show (one choice for the whole page: Show, Take profits, Traders; the Plus choices tagged, and locked without Plus); then why nothing
 * shows where they cannot, and which snapshot is on the map and whose it is.
 */
export function buildLiqLevelPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, source: LiqLevelsSource | null): void {
  const s = store.state.liqLevels, member = plusOn();
  const set = (change: Partial<LiqLevelSettings>, again = false): void => { store.set({ liqLevels: { ...store.state.liqLevels, ...change } }); if (again) rebuild(); };
  // A Plus choice without Plus opens the Plus panel (by this panel's button, since one panel is open at a time) and changes nothing.
  const choose = (change: LiqChange, from: HTMLElement): void => { chooseLiq(store, change, openedPanel()?.anchor ?? from); rebuild(); };
  tools.append(helpButton('liqLevels'));
  body.append(
    switchRow(t('Show liquidation levels'), HELP.liqLevels.tip, s.on, on => set({ on }, true)),
    switchRow(t('Liquidation column'), t('A column of its own beside the profile column: in each row what still stands of the liquidation levels, and a curve of everything from the price out to each price, read where you point on a computer.'), s.column, column => set({ column })),
  );
  // What they show. Each row is a segment; a Plus segment carries the tag.
  const kinds = segmented(LIQ_KINDS.map(kind => [kind, kindName(kind)]), s.kind, value => { choose({ kind: value as LiqLevelSettings['kind'] }, kinds); });
  [...kinds.children].forEach((b, i) => { if (LIQ_KINDS[i] !== 'liq') b.append(plusTag(member)); });
  kinds.classList.add('liq-choice');
  const takes = switchRow(t('Take profits'), t('Take-profit orders as a layer of their own beside the levels: the sells that close longs above the price, the buys that close shorts below it.'), s.takes, on => { choose({ takes: on }, takes); });
  takes.querySelector('.name')?.append(plusTag(member));
  const stopsOnly = s.kind === 'stops';
  const groups = segmented(LIQ_GROUPS.map(group => [group, groupName(group)]), s.group, value => { choose({ group: value as LiqLevelSettings['group'] }, groups); });
  [...groups.children].forEach((b, i) => { if (LIQ_GROUPS[i] !== 'all') b.append(plusTag(member)); if (stopsOnly) (b as HTMLButtonElement).disabled = true; });
  groups.classList.add('liq-choice');
  if (stopsOnly) groups.dataset.tip = noGroupsTip();
  body.append(heading(t('Show')), kinds, takes, heading(t('Traders')), groups,
    note(stopsOnly ? noGroupsTip() : t('Profitable traders: the wallets HyperTracker counts as profitable, its four cohorts with a positive all-time perp profit.')));
  if (heldBack(s, member)) body.append(note(t('Without Plus the page shows liquidations of all traders. Your choice is kept and comes back with Plus.')));
  // What the map leaves unsaid, it being on by default: why nothing shows.
  const view = liveView(s);
  if (replaying()) body.append(note(t('Liquidation levels show the live market only.')));
  else if (source?.state === 'other-coin') body.append(note(t('Liquidation levels are for BTC only for now.')));
  else if (source) {
    const levels = source.levels;
    body.append(note(levels && source.state === 'ready' ? liqNote(source, view, levels.asOf) : liqWhy(source, source.asOfs().liq) || t('Liquidation levels are loading.')));
  }
}
