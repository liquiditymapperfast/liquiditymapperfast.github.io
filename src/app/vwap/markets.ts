import { CANDLE_VENUES } from '../../shared/history.ts';
import { instrumentIdFor, type Coin, type MarketVenue } from '../../shared/coins.ts';
import { historyTarget, type HistoryTarget } from '../keylevels/history.ts';

/**
 * Whose candles the VWAP lines are worked out from (Karl, 2026-11-10: "choose to load historical data for multiple exchanges, not just the
 * default"): the chart's market (the default, as before, or the market standing in for it where its history cannot be read: `historyTarget`),
 * or markets a person chooses, added up bar by bar (`mergeVwapBars`). A choice is an exchange and a kind (`binance/perp`, `bybit/spot`, the
 * form `market-choice.ts` saves), never an instrument id, so a layout made on BTC means the same exchanges on ETH; it stands for that
 * exchange's market of that kind the coin is listed on, when the page can read its candles (`CANDLE_VENUES`).
 */
export type VwapSource = 'chart' | 'chosen';

/** The most markets one VWAP adds up: each is read at every bar size the lines use. */
export const MAX_VWAP_MARKETS = 6;

/** The candle venue of each exchange's perpetual and spot market (Coinbase has spot alone, Hyperliquid and Deribit perpetuals alone). */
const VENUE_OF: Readonly<Record<string, string>> = {
  'binance/perp': 'binance', 'binance/spot': 'binancespot', 'bybit/perp': 'bybit', 'bybit/spot': 'bybitspot', 'okx/perp': 'okx', 'okx/spot': 'okxspot',
  'bitget/perp': 'bitget', 'bitget/spot': 'bitgetspot', 'coinbase/spot': 'coinbase', 'hyperliquid/perp': 'hyperliquid', 'deribit/perp': 'deribit',
};
/** The choices the VWAP offers, in the panel's order: by exchange, the perpetual first. */
export const VWAP_PICKS: readonly string[] = Object.keys(VENUE_OF).filter(p => CANDLE_VENUES.includes(VENUE_OF[p]!));
export const isVwapPick = (pick: unknown): pick is string => typeof pick === 'string' && VWAP_PICKS.includes(pick);

/** Saved choices, checked: those offered, each once, at most `MAX_VWAP_MARKETS`. */
export function readVwapPicks(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isVwapPick))].slice(0, MAX_VWAP_MARKETS) : [];
}

/** The chart's market as the page names it for its candles (a server names Binance spot `binance:BTCUSDT:spot`, the history `binancespot:BTCUSDT`). */
const chartCandleId = (chartId: string): string => { const spot = /^([^:]+):(.+):spot$/.exec(chartId); return spot ? `${spot[1]}spot:${spot[2]}` : chartId; };

/** The market a choice stands for on `coin`, or null where the coin is not listed there or its candles cannot be read. */
export function pickTarget(pick: string, coin: Coin, chartId: string): HistoryTarget | null {
  const venue = isVwapPick(pick) ? VENUE_OF[pick]! : null;
  if (!venue) return null;
  const listing = coin.markets[venue as MarketVenue], id = instrumentIdFor(venue, coin);
  return listing && id ? { id, listing, own: id === chartCandleId(chartId) } : null;
}

/** The choice that stands for a market (`binancespot:BTCUSDT` is `binance/spot`), or null for a market the VWAP does not offer. */
export function pickOfMarket(id: string): string | null {
  const venue = id.split(':')[0]!;
  return VWAP_PICKS.find(p => VENUE_OF[p] === venue) ?? null;
}

/**
 * The choices a person starts from when switching to chosen markets: the market the lines read now (the chart's, or the one standing in for
 * it), so the lines do not change until a box is ticked.
 */
export function seedPicks(chartId: string, coin: Coin): string[] {
  const target = historyTarget(chartId, coin), pick = target ? pickOfMarket(target.id) : null;
  return pick ? [pick] : [];
}

/**
 * The markets the VWAP lines are worked out from: the chart's own (or the one standing in for it), or the chosen ones the coin is listed on,
 * each once, at most `MAX_VWAP_MARKETS`. Empty when none of the chosen ones is (the panel says so; the lines draw nothing).
 */
export function vwapTargets(source: VwapSource, picks: readonly string[], chartId: string, coin: Coin): HistoryTarget[] {
  if (source === 'chart') { const one = historyTarget(chartId, coin); return one ? [one] : []; }
  const out: HistoryTarget[] = [];
  for (const pick of picks) {
    const target = pickTarget(pick, coin, chartId);
    if (target && !out.some(t => t.id === target.id)) out.push(target);
    if (out.length >= MAX_VWAP_MARKETS) break;
  }
  return out;
}

/**
 * The currency a market's prices are quoted in, from how it is listed: USDC or USDT where its name says so, Hyperliquid's perpetuals in USDC,
 * USD otherwise (Coinbase's BTC-USD, Deribit's inverse perpetuals). Markets quoted in different ones are a few hundredths of a percent apart.
 */
export function quoteOf(target: HistoryTarget): string {
  const venue = target.id.split(':')[0]!, symbol = target.listing.symbol.toUpperCase();
  if (/USDC/.test(symbol) || venue === 'hyperliquid') return 'USDC';
  if (/USDT/.test(symbol)) return 'USDT';
  return 'USD';
}

/**
 * How a market the VWAP lines read stands (the map's `vwapMarketStates`, for the panel): its candles held ('ready'), on their way ('coming'),
 * not read just now and tried again in a minute ('failed'), held but not read again for minutes ('stale': several markets' lines end where it
 * was last read, `readTo`), or held but reaching back only to `from` where a line needs them from earlier, the exchange having nothing older
 * the page can read ('short').
 */
export interface VwapMarketState { target: HistoryTarget; state: 'ready' | 'coming' | 'failed' | 'stale' | 'short'; readTo: number; from: number }
