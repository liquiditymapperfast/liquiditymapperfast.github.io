import type { Store } from './store.ts';
import { note, openedPanel, switchRow } from './ui.ts';
import { HELP, helpButton } from './help.ts';
import { t } from './i18n.ts';
import type { LiqLevelsSource } from './liq-levels.ts';
import type { LiqLevelSettings } from './liq-url.ts';
import { replaying } from './replay/clock.ts';
import { liveView } from './liq-view.ts';
import { liqNote, liqWhy } from './liq-words.ts';
import { createLevelsControl, type LevelsControl } from './levels-control.ts';
import { togglePlus } from './plus/panel.ts';

/** The control the open Liq levels panel holds: dropped (its listeners ended) when the panel draws afresh or closes. */
let held: Pick<LevelsControl, 'destroy'> | null = null;
/** Hold `control` as the panel's, dropping the one before it. */
export function holdPanelControl<T extends Pick<LevelsControl, 'destroy'>>(control: T): T { held?.destroy(); held = control; return control; }
/** The panel closed: its control is dropped. */
export function releaseLiqLevelPanel(): void { held?.destroy(); held = null; }

/**
 * The Liquidation levels panel: its first row switches them on and off, the second their own column beside the profile column; then the levels
 * control, the one the column's button opens (what they show: liquidations, stops, take profits, and whose); then why nothing shows where
 * they cannot, and which snapshot is on the map and whose it is.
 */
export function buildLiqLevelPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, source: LiqLevelsSource | null): void {
  const s = store.state.liqLevels;
  const set = (change: Partial<LiqLevelSettings>, again = false): void => { store.set({ liqLevels: { ...store.state.liqLevels, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('liqLevels'));
  // A Plus choice without Plus opens the Plus panel (by this panel's button, since one panel is open at a time) and changes nothing.
  const control = holdPanelControl(createLevelsControl(store, { locked: from => { togglePlus(openedPanel()?.anchor ?? from); } }));
  control.root.classList.add('lv-in-panel');
  body.append(
    switchRow(t('Show liquidation levels'), HELP.liqLevels.tip, s.on, on => set({ on }, true)),
    switchRow(t('Liquidation column'), t('A column of its own beside the profile column: in each row what still stands of the liquidation levels, and a curve of everything from the price out to each price, read where you point on a computer.'), s.column, column => set({ column })),
    control.root,
  );
  // What the map leaves unsaid, it being on by default: why nothing shows.
  const view = liveView(s);
  if (replaying()) body.append(note(t('Liquidation levels show the live market only.')));
  else if (source?.state === 'other-coin') body.append(note(t('Liquidation levels are for BTC only for now.')));
  else if (source) {
    const levels = source.levels;
    body.append(note(levels && source.state === 'ready' ? liqNote(source, view, levels.asOf) : liqWhy(source, source.asOfs().liq) || t('Liquidation levels are loading.')));
  }
}
