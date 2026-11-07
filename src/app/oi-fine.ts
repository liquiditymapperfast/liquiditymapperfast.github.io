import type { AppState } from './store.ts';
import type { OiPart } from './oi-change.ts';
import { HISTORY_CAP_MS } from './delta/flows.ts';
import { fundingVenueOf } from './funding.ts';
import { currentCoin } from './coin.ts';
import { instrumentIdFor } from '../shared/coins.ts';

/**
 * The minute readings NL/NS works candles out on (store `oiFine`, delta/nlns.ts): each counted market's own open interest a minute apart where
 * it was read that often. Read as far back as the page holds flow a second at a time (delta/flows.ts, the same constant): a minute's change is
 * given to that minute's takers, so minute readings without minute flow would say nothing.
 */
export const OI_FINE_MS = HISTORY_CAP_MS;
/** Their newest minutes are read again at most this often; the pushes keep the newest minute current meanwhile (`Hub.loadOiFine`). */
export const OI_FINE_TAIL_MS = 60_000;

/** The markets on screen as parts: the venues added together, or the one market's bars (`oi`) with the one price an inverse market's are at. */
export function partsOnScreen(state: Pick<AppState, 'oi' | 'oiParts' | 'oiInstrument' | 'oiPrice'>): OiPart[] {
  return state.oiParts.length > 1 ? state.oiParts : state.oiInstrument && state.oi.length ? [{ id: state.oiInstrument, bars: state.oi, ...(state.oiPrice ? { usdAt: state.oiPrice } : {}) }] : [];
}

/**
 * The markets whose minute readings are read: every market counted while the OI pane's bars are split by who or the Delta pane shows NL/NS;
 * with only the Funding pane wanting them, Hyperliquid's perpetual alone, and only while it shows Hyperliquid (its share of new positions
 * buyers opened, hour by hour). None on a one-minute chart: there the candle is the minute.
 */
export function fineTargets(state: Pick<AppState, 'show' | 'oiChange' | 'delta' | 'fundingVenue' | 'oi' | 'oiParts' | 'oiInstrument' | 'oiPrice'>, tfMs: number): OiPart[] {
  if (tfMs <= 60_000) return [];
  if ((state.show.oi && state.oiChange === 'who') || (state.show.delta && state.delta.style === 'nlns')) return partsOnScreen(state);
  if (!state.show.funding) return [];
  const coin = currentCoin();
  if (fundingVenueOf(state.fundingVenue, v => !!coin.markets[v]) !== 'hyperliquid') return [];
  const id = instrumentIdFor('hyperliquid', coin);
  return partsOnScreen(state).filter(part => part.id === id);
}

/** What a set of minute readings is read for: its markets, and an inverse market's one price. */
export const fineKey = (parts: readonly OiPart[]): string => parts.map(part => `${part.id}@${part.usdAt ?? 0}`).join(',');
