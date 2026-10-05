/** Keep feed failure state scoped to the venue that owns the feed. */
export function venueForFeedId(id: unknown): string | null {
  const value = String(id ?? '');
  if (value.startsWith('hl-')) return 'hyperliquid';
  if (value.startsWith('binance-')) return 'binance';
  if (value.startsWith('bybit-')) return 'bybit';
  if (value.startsWith('okx-')) return 'okx';
  if (value.startsWith('bitget-')) return 'bitget';
  if (value.startsWith('gateio-')) return 'gateio';
  if (value.startsWith('deribit-')) return 'deribit';
  if (value.startsWith('coinbase-')) return 'coinbase';
  if (value.startsWith('kraken-')) return 'kraken';
  if (value.startsWith('kucoin-')) return 'kucoin';
  if (value.startsWith('mexc-')) return 'mexc';
  if (value.startsWith('htx-')) return 'htx';
  if (value.startsWith('bitfinex-')) return 'bitfinex';
  if (value.startsWith('bitmex-')) return 'bitmex';
  if (value.startsWith('cryptocom-')) return 'cryptocom';
  if (value.startsWith('bitstamp-')) return 'bitstamp';
  if (value.startsWith('whitebit-')) return 'whitebit';
  if (value.startsWith('phemex-')) return 'phemex';
  if (value.startsWith('dydx-')) return 'dydx';
  if (value.startsWith('aster-')) return 'aster';
  return null;
}

export function applyFeedStatus(statuses: Record<string, Record<string, unknown>> = {}, id: unknown, patch: Record<string, unknown> = {}) {
  const venue = venueForFeedId(id);
  if (!venue) return statuses;
  return { ...statuses, [venue]: { ...(statuses[venue] ?? {}), ...patch, venue } };
}
