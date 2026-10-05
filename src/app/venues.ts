/** Display names for venue ids (the part of an instrument id before the colon). */
const NAMES: Readonly<Record<string, string>> = {
  aster: 'Aster', binance: 'Binance', binanceus: 'Binance US', binancespot: 'Binance spot', bitfinex: 'Bitfinex', bitget: 'Bitget', bitmart: 'BitMart', bitmex: 'BitMEX',
  bitstamp: 'Bitstamp', bitunix: 'Bitunix', bybit: 'Bybit', coinbase: 'Coinbase', cryptocom: 'Crypto.com', deribit: 'Deribit', dydx: 'dYdX', gateio: 'Gate.io',
  hitbtc: 'HitBTC', htx: 'HTX', hyperliquid: 'Hyperliquid', kraken: 'Kraken', kucoin: 'KuCoin', mexc: 'MEXC', okx: 'OKX', phemex: 'Phemex', poloniex: 'Poloniex', whitebit: 'WhiteBIT',
};

export function venueLabel(id: string): string {
  const venue = id.split(':')[0]!;
  return NAMES[venue] ?? venue.replace(/^./, c => c.toUpperCase());
}
