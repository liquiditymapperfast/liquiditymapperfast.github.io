/** Display names for venue ids (the part of an instrument id before the colon). */
const NAMES: Readonly<Record<string, string>> = {
  aster: 'Aster', binance: 'Binance', binanceus: 'Binance US', binancespot: 'Binance spot', bitfinex: 'Bitfinex', bitget: 'Bitget', bitgetspot: 'Bitget spot', bitmart: 'BitMart', bitmex: 'BitMEX',
  bitstamp: 'Bitstamp', bitunix: 'Bitunix', bybit: 'Bybit', bybitspot: 'Bybit spot', coinbase: 'Coinbase', cryptocom: 'Crypto.com', deribit: 'Deribit', dydx: 'dYdX', gateio: 'Gate.io',
  hitbtc: 'HitBTC', htx: 'HTX', hyperliquid: 'Hyperliquid', kraken: 'Kraken', kucoin: 'KuCoin', mexc: 'MEXC', okx: 'OKX', okxspot: 'OKX spot', phemex: 'Phemex', poloniex: 'Poloniex', whitebit: 'WhiteBIT',
};

/** A short handle for a venue in popups: "binance-spot", "hyperliquid". */
export function venueSlug(id: string): string { return venueLabel(id).toLowerCase().replace(/\s+/g, '-'); }

export function venueLabel(id: string): string {
  const venue = id.split(':')[0]!;
  return NAMES[venue] ?? venue.replace(/^./, c => c.toUpperCase());
}
