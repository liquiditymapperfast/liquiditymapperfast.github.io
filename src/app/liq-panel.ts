import type { Store } from './store.ts';
import { note, switchRow } from './ui.ts';
import { HELP, helpButton } from './help.ts';
import { t } from './i18n.ts';
import { clock } from './format.ts';
import type { LiqLevelsSource } from './liq-levels.ts';
import type { LiqLevelSettings } from './liq-url.ts';
import { replaying } from './replay/clock.ts';

/**
 * The Liquidation levels panel: its first row switches them on and off, the second their own column beside the profile column; then why
 * nothing shows where they cannot, and which snapshot is on the map and whose it is.
 */
export function buildLiqLevelPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, source: LiqLevelsSource | null): void {
  const s = store.state.liqLevels;
  const set = (change: Partial<LiqLevelSettings>, again = false): void => { store.set({ liqLevels: { ...store.state.liqLevels, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('liqLevels'));
  body.append(
    switchRow(t('Show liquidation levels'), HELP.liqLevels.tip, s.on, on => set({ on }, true)),
    switchRow(t('Liquidation column'), t('A column of its own beside the profile column: in each row what still stands of the liquidation levels, and a curve of everything from the price out to each price, read where you point on a computer.'), s.column, column => set({ column })),
  );
  // What the map leaves unsaid, it being on by default: why nothing shows.
  if (replaying()) body.append(note(t('Liquidation levels show the live market only.')));
  else if (source?.state === 'other-coin') body.append(note(t('Liquidation levels are for BTC only for now.')));
  const levels = source?.levels;
  if (levels) body.append(note(t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time: clock(levels.asOf) })));
}
