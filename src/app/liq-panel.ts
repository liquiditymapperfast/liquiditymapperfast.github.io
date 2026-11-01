import type { Store } from './store.ts';
import { note, switchRow } from './ui.ts';
import { HELP, helpButton } from './help.ts';
import { t } from './i18n.ts';
import { clock } from './format.ts';
import type { LiqLevelsSource } from './liq-levels.ts';
import type { LiqLevelSettings } from './liq-url.ts';
import { replaying } from './replay/clock.ts';

/**
 * The Liquidation levels panel: its first row switches them on and off, the second whether the profile column adds them up in place of the
 * order book; then which snapshot is on the map and whose it is.
 */
export function buildLiqLevelPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, source: LiqLevelsSource | null): void {
  const s = store.state.liqLevels;
  const set = (change: Partial<LiqLevelSettings>, again = false): void => { store.set({ liqLevels: { ...store.state.liqLevels, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('liqLevels'));
  body.append(
    switchRow(t('Show liquidation levels'), HELP.liqLevels.tip, s.on, on => set({ on }, true)),
    switchRow(t('Add them up in the profile column'), t('The column at the right edge of the map shows the liquidation levels in place of the order book: in each row what still stands, and faint behind it everything from the price out to that row.'), s.profile, profile => set({ profile })),
  );
  // What the map leaves unsaid, it being on by default: why nothing shows.
  if (replaying()) body.append(note(t('Liquidation levels show the live market only.')));
  else if (source?.state === 'other-coin') body.append(note(t('Liquidation levels are for BTC only for now.')));
  const levels = source?.levels;
  if (levels) body.append(note(t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time: clock(levels.asOf) })));
}
