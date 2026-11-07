import type { AppState } from './store.ts';
import type { OiPart } from './oi-change.ts';

/**
 * The minute readings NL/NS works candles out on (store `oiFine`, delta/nlns.ts): each counted market's own open interest a minute apart where
 * it was read that often. Read as far back as the page holds flow a second at a time (delta/flows.ts): a minute's change is given to that
 * minute's takers, so minute readings without minute flow would say nothing.
 */
export const OI_FINE_MS = 24 * 3_600_000;
/** Their newest minutes are read again at most this often; the pushes keep the newest minute current meanwhile (`Hub.loadOiFine`). */
export const OI_FINE_TAIL_MS = 60_000;

/**
 * Whether anything shown works NL/NS out, so the minute readings are read: the OI pane's bars by who opened, NL/NS in the Delta pane, or the
 * Funding pane (Hyperliquid's share of new positions opened by buyers). Never on a one-minute chart: there the candle is the minute.
 */
export function fineWanted(state: Pick<AppState, 'show' | 'oiChange' | 'delta'>, tfMs: number): boolean {
  return tfMs > 60_000 && ((state.show.oi && state.oiChange === 'who') || (state.show.delta && state.delta.style === 'nlns') || state.show.funding);
}

/** The markets on screen as parts: the venues added together, or the one market's bars (`oi`) with the one price an inverse market's are at. */
export function partsOnScreen(state: Pick<AppState, 'oi' | 'oiParts' | 'oiInstrument' | 'oiPrice'>): OiPart[] {
  return state.oiParts.length > 1 ? state.oiParts : state.oiInstrument && state.oi.length ? [{ id: state.oiInstrument, bars: state.oi, ...(state.oiPrice ? { usdAt: state.oiPrice } : {}) }] : [];
}
