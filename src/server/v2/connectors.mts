import { inflateRawSync } from 'node:zlib';
import { BinanceSpotConnector, BinanceUsConnector, BitunixConnector, BookConnector, HitbtcConnector, PoloniexConnector } from '../../shared/connector.ts';

import { BinanceSpotBook, BitgetSpotConnector, BybitSpotConnector, OkxSpotConnector } from '../../shared/venues.ts';
import { BTC, type Coin, type MarketVenue } from '../../shared/coins.ts';
export { BinanceSpotConnector, BinanceUsConnector, BitunixConnector, BookConnector, HitbtcConnector, PoloniexConnector, type ConnectorState, type ConnectorStatus } from '../../shared/connector.ts';

/** BitMart spot depth50: deflate-compressed full snapshots. */
export class BitmartConnector extends BookConnector {
  readonly id = 'bitmart'; readonly name = 'BitMart'; readonly symbol = 'BTC_USDT'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected url() { return 'wss://ws-manager-compress.bitmart.com/api?protocol=1.1'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [`spot/depth50:${this.symbol}`] }); }
  /** Whole depth50 snapshots are re-sent several times a second. */
  protected override coalesceMs() { return 400; }
  override decode(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) { try { return inflateRawSync(Buffer.from(data)).toString('utf8'); } catch { return Buffer.from(data).toString('utf8'); } }
    return null;
  }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m || m.table !== 'spot/depth50' || !Array.isArray(m.data)) return;
    for (const item of m.data) {
      const d = this.record(item); if (!d || d.symbol !== this.symbol) continue;
      this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); this.touch();
    }
  }
}

export const CONNECTOR_FACTORIES: Record<string, () => BookConnector> = {
  binanceus: () => new BinanceUsConnector(), binancespot: () => new BinanceSpotConnector(), hitbtc: () => new HitbtcConnector(), poloniex: () => new PoloniexConnector(),
  // The spot markets of exchanges whose perpetual the feed manager serves: these connectors carry their own trades.
  bybitspot: () => new BybitSpotConnector(), okxspot: () => new OkxSpotConnector(), bitgetspot: () => new BitgetSpotConnector(),
  bitmart: () => new BitmartConnector(), bitunix: () => new BitunixConnector(),
};

/**
 * The connector venues for the coin a server records. BTC has all of them; another coin has the four large spot markets that list it
 * (the small connectors are BTC-only), each reading the market's own name for the coin from the coin list.
 */
export function connectorFactories(coin: Coin): Record<string, () => BookConnector> {
  if (coin.coin === BTC.coin) return CONNECTOR_FACTORIES;
  const market = (venue: MarketVenue) => { const listing = coin.markets[venue]; return listing ? { coin: coin.coin, ...listing } : null; };
  const out: Record<string, () => BookConnector> = {};
  const binance = market('binancespot'), bybit = market('bybitspot'), okx = market('okxspot'), bitget = market('bitgetspot');
  if (binance) out.binancespot = () => new BinanceSpotBook(binance);
  if (bybit) out.bybitspot = () => new BybitSpotConnector(bybit);
  if (okx) out.okxspot = () => new OkxSpotConnector(okx);
  if (bitget) out.bitgetspot = () => new BitgetSpotConnector(bitget);
  return out;
}
