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
 * What wants minute readings: every market counted (`all`: the OI pane's bars split by who, NL/NS in the Delta pane), Hyperliquid's perpetual
 * alone (`hyperliquid`: only the Funding pane, while it shows Hyperliquid, for its share of new positions buyers opened hour by hour), or
 * nothing (null; always on a one-minute chart, where the candle is the minute). Apart from which markets are on screen: a timeframe or market
 * switch clears those for a moment, and what is held must not be let go then.
 */
export function fineWant(state: Pick<AppState, 'show' | 'oiChange' | 'delta' | 'fundingVenue'>, tfMs: number): 'all' | 'hyperliquid' | null {
  if (tfMs <= 60_000) return null;
  if ((state.show.oi && state.oiChange === 'who') || (state.show.delta && state.delta.style === 'nlns')) return 'all';
  if (!state.show.funding) return null;
  const coin = currentCoin();
  return fundingVenueOf(state.fundingVenue, v => !!coin.markets[v]) === 'hyperliquid' ? 'hyperliquid' : null;
}

/** The markets on screen whose minute readings are read (`fineWant`); none while it wants none, or while the markets are being read again. */
export function fineTargets(state: Pick<AppState, 'show' | 'oiChange' | 'delta' | 'fundingVenue' | 'oi' | 'oiParts' | 'oiInstrument' | 'oiPrice'>, tfMs: number): OiPart[] {
  const want = fineWant(state, tfMs);
  if (!want) return [];
  const parts = partsOnScreen(state);
  if (want === 'all') return parts;
  const id = instrumentIdFor('hyperliquid', currentCoin());
  return parts.filter(part => part.id === id);
}

/**
 * The markets whose minute readings may be kept (`targets`: `fineTargets` now), or null to keep all: Hyperliquid's perpetual alone while only the
 * Funding pane wants them, whether it is counted or not; every market wanted while some are on screen; all of them while none are (a timeframe
 * or market switch has cleared the markets on screen for a moment, and they are the same markets after it).
 */
export function fineKept(state: Pick<AppState, 'show' | 'oiChange' | 'delta' | 'fundingVenue'>, tfMs: number, targets: readonly OiPart[]): Set<string> | null {
  const want = fineWant(state, tfMs);
  if (want === 'hyperliquid') { const id = instrumentIdFor('hyperliquid', currentCoin()); return new Set(id ? [id] : []); }
  return want && targets.length ? new Set(targets.map(part => part.id)) : null;
}

/**
 * Which markets a set of minute readings is read for. Not an inverse market's one price: that follows each whole read of the bars on screen,
 * and a new one must not ask for a day of minutes again (the minutes take it at their own next whole read).
 */
export const fineKey = (parts: readonly OiPart[]): string => parts.map(part => part.id).join(',');
