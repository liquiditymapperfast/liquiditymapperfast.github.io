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

/**
 * One line colour per venue for panes that draw a line each (Long/Short, Funding's every venue), apart from each other on either theme (the
 * brands' own are black on two of them) and from the buy and sell colours; the venue's mark ends its line.
 */
export const VENUE_LINE: Readonly<Record<string, string>> = { binance: '#d4a106', bybit: '#e8590c', okx: '#7a5af8', bitget: '#0ca5b8', hyperliquid: '#3d8bfd', deribit: '#8d6e63' };
