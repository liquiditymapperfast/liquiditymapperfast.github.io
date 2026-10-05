import type { LiveFeedStartOptions } from './live-feeds.mts';
import { ORDERBOOK_VENUE_MAX_SELECTED } from '../core/orderbook-venue-controls.mts';
import { rebaseLiveFeedConfiguration } from './live-feed-config.mts';
import { publicMarketFeedOptions } from './public-market-selection.mts';
import { binanceInstrumentId } from '../adapters/binance.mts';
import { bybitInstrumentId } from '../adapters/bybit.mts';
import { bitgetInstrumentId } from '../adapters/bitget.mts';

export const PUBLIC_ORDERBOOK_MAX_SELECTED = ORDERBOOK_VENUE_MAX_SELECTED;
export const PUBLIC_ORDERBOOK_VENUE_IDS = Object.freeze([
  'hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'gateio', 'deribit', 'coinbase', 'kraken', 'kucoin',
  'mexc', 'htx', 'bitfinex', 'bitmex', 'cryptocom', 'bitstamp', 'whitebit', 'phemex', 'dydx', 'aster',
] as const);
export type PublicOrderbookVenueId = typeof PUBLIC_ORDERBOOK_VENUE_IDS[number];
/**
 * The venues a first run starts with: the largest by 24 h volume and open interest whose public book is also deep, fresh and reliable
 * (Binance, Bybit, OKX, Bitget, Hyperliquid, Deribit on the perpetual side; Coinbase for spot, with Binance spot in `venues.mts`).
 * Gate.io and MEXC are big by volume but publish only a few levels; the rest are small or stale. The measurements are in
 * `docs/deslop/venue-defaults-2026-10-05.md`; the Venues picker's Recommended button applies this set.
 */
export const PUBLIC_ORDERBOOK_DEFAULT_VENUES: readonly PublicOrderbookVenueId[] = Object.freeze(['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit', 'coinbase']);
export interface PublicOrderbookVenueCatalogEntry {
  readonly id: PublicOrderbookVenueId; readonly name: string; readonly supported: boolean; readonly default: boolean; readonly reason?: string;
}
const NAMES = ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget', 'Gate.io', 'Deribit', 'Coinbase', 'Kraken', 'KuCoin',
  'MEXC', 'HTX', 'Bitfinex', 'BitMEX', 'Crypto.com', 'Bitstamp', 'WhiteBIT', 'Phemex', 'dYdX', 'Aster'] as const;
const CATALOG: readonly PublicOrderbookVenueCatalogEntry[] = Object.freeze(PUBLIC_ORDERBOOK_VENUE_IDS.map((id, index) => Object.freeze({
  id, name: NAMES[index]!, supported: true, default: PUBLIC_ORDERBOOK_DEFAULT_VENUES.includes(id),
})));
/** Adapter capability, not a claim that a selected product is active or admitted. */
export function publicOrderbookVenueCatalog(): readonly PublicOrderbookVenueCatalogEntry[] { return CATALOG; }
export interface PublicOrderbookStreamPlan {
  readonly venue: PublicOrderbookVenueId; readonly feedId: string; readonly nativeSymbol: string; readonly instrumentId: string;
  readonly base: 'BTC' | 'ETH'; readonly quote: string; readonly marketType: 'spot' | 'perpetual'; readonly metadataRequired: true;
}
export type PublicOrderbookSelectionPlan = { ok: true; base: 'BTC' | 'ETH'; venues: readonly PublicOrderbookVenueId[];
  options: LiveFeedStartOptions; streams: readonly PublicOrderbookStreamPlan[] } | { ok: false; reason: string; venue?: PublicOrderbookVenueId };
type Family = 'base-perpetual' | 'spot' | 'usdm' | 'coinm' | 'linear' | 'inverse' | 'swap' | 'usdt-futures';
interface ProductIdentity { venue: PublicOrderbookVenueId; base: 'BTC' | 'ETH'; quote: string; native: string; id: string; marketType: 'spot' | 'perpetual'; family: Family | null; }
const STABLE_QUOTES: readonly string[] = ['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI'];
const OPTIONAL_VENUES = PUBLIC_ORDERBOOK_VENUE_IDS.filter((id): id is Exclude<PublicOrderbookVenueId, 'hyperliquid' | 'binance'> => id !== 'hyperliquid' && id !== 'binance');
const PRODUCT_KEYS = ['venue', 'exchange', 'nativeSymbol', 'symbol', 'instrumentId', 'id', 'base', 'quote', 'marketType', 'discoveryFamily',
  'family', 'category', 'instType', 'contractType', 'inverse', 'isDelisted', 'status'] as const;
const CONFIG_STRING_KEYS = ['coin', 'hlNativeCoin', 'binanceSymbol', 'binanceMarketType', 'binanceFamily', 'bybitCategory', 'okxMarketType', 'bitgetMarketType', 'candleInterval',
  ...OPTIONAL_VENUES.map(id => id + 'Symbol')];
function fail(reason: string, venue?: PublicOrderbookVenueId): PublicOrderbookSelectionPlan { return venue === undefined ? { ok: false, reason } : { ok: false, reason, venue }; }
function ownValues(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) return null;
    const item: unknown = descriptor.value;
    if (item !== undefined && item !== null && typeof item !== 'string' && typeof item !== 'boolean') return null;
    if (typeof item === 'string' && (item.length > 128 || item.trim() !== item)) return null;
    result[key] = item;
  }
  return result;
}
function selectedIds(value: unknown): PublicOrderbookVenueId[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > PUBLIC_ORDERBOOK_MAX_SELECTED) return null;
  const result: PublicOrderbookVenueId[] = [];
  for (let index = 0; index < length.value; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !('value' in entry) || typeof entry.value !== 'string') return null;
    const venue = PUBLIC_ORDERBOOK_VENUE_IDS.find(id => id === entry.value);
    if (!venue || result.includes(venue)) return null;
    result.push(venue);
  }
  return result;
}
/** Copy only a bounded top-level configuration shell, without invoking accessors.
 * Non-consumed transport/grouping values are borrowed intact; manager validators own them. */
function safeBaseline(value: unknown): LiveFeedStartOptions | null {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const result: LiveFeedStartOptions = Object.create(null) as LiveFeedStartOptions;
  let count = 0;
  for (const key in value) {
    if (++count > 96 || key.length > 128) return null;
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (!entry || !('value' in entry)) return null;
    Object.defineProperty(result, key, { value: entry.value, enumerable: true, writable: true, configurable: true });
  }
  // Include and validate hidden own configuration fields read by the rebaser.
  for (const key of [...CONFIG_STRING_KEYS, ...OPTIONAL_VENUES.map(id => id + 'Enabled')]) {
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (!entry) continue;
    if (!('value' in entry)) return null;
    const item: unknown = entry.value;
    if (key.endsWith('Enabled')) { if (item !== undefined && typeof item !== 'boolean') return null; }
    else if (item !== undefined && item !== null && (typeof item !== 'string' || item.length > 64 || item.trim() !== item)) return null;
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function familyFor(row: Record<string, unknown>, venue: PublicOrderbookVenueId, native: string, marketType: 'spot' | 'perpetual', quote: string): Family | null {
  let family: Family | null = null;
  if (venue === 'hyperliquid') family = 'base-perpetual';
  else if (venue === 'binance') family = marketType === 'spot' ? 'spot' : native.endsWith('USD_PERP') ? 'coinm' : 'usdm';
  else if (venue === 'bybit') family = marketType === 'spot' ? 'spot' : quote === 'USD' ? 'inverse' : 'linear';
  else if (venue === 'okx') family = marketType === 'spot' ? 'spot' : 'swap';
  else if (venue === 'bitget') family = marketType === 'spot' ? 'spot' : 'usdt-futures';
  if (row.discoveryFamily !== undefined && row.discoveryFamily !== family) throw new TypeError('Native family and discovery family disagree');
  if (venue === 'binance' && row.family !== undefined && row.family !== (family === 'spot' ? 'usdm' : family)) throw new TypeError('Native Binance family disagrees');
  if (venue === 'bybit' && row.category !== undefined && row.category !== family) throw new TypeError('Native Bybit category disagrees');
  if (venue === 'okx' && row.instType !== undefined && String(row.instType).toUpperCase() !== (family === 'spot' ? 'SPOT' : 'SWAP')) throw new TypeError('Native OKX family disagrees');
  if (venue === 'bitget' && row.instType !== undefined && String(row.instType).toLowerCase() !== family) throw new TypeError('Native Bitget family disagrees');
  return family;
}
function streamFor(venue: PublicOrderbookVenueId, native: string, base: 'BTC' | 'ETH', marketType: 'spot' | 'perpetual', options: LiveFeedStartOptions): PublicOrderbookStreamPlan | null {
  const upper = native.toUpperCase(), spot = marketType === 'spot';
  let quote = '', id = venue + ':' + upper;
  const pair = (prefix: string, separator = '', suffix = '', allowed: readonly string[] = STABLE_QUOTES) => allowed.find(item => upper === prefix + separator + item + suffix) ?? '';
  if (venue === 'hyperliquid') { if (spot || upper !== base) return null; quote = 'USD'; id = 'hyperliquid:' + base + '-PERP'; }
  else if (venue === 'binance') {
    if (options.binanceFamily === 'coinm') { if (spot || upper !== base + 'USD_PERP') return null; quote = 'USD'; }
    else quote = pair(base, '', '', spot ? STABLE_QUOTES : ['USDT', 'USDC']);
    id = binanceInstrumentId(native, marketType, options.binanceFamily);
  } else if (venue === 'bybit') {
    if (options.bybitCategory === 'inverse') { if (spot) return null; quote = pair(base, '', '', ['USD']); }
    else if (options.bybitCategory === 'linear' && upper === base + 'PERP') quote = 'USDC';
    else quote = pair(base, '', '', spot ? STABLE_QUOTES : ['USDT', 'USDC']);
    id = bybitInstrumentId(native, options.bybitCategory);
  } else if (venue === 'okx') quote = pair(base, '-', spot ? '' : '-SWAP');
  else if (venue === 'bitget') { quote = pair(base, '', '', spot ? STABLE_QUOTES : ['USDT']); id = bitgetInstrumentId(native, spot ? 'spot' : 'usdt-futures'); }
  else if (venue === 'gateio' || venue === 'mexc') { if (spot) return null; quote = pair(base, '_', '', ['USDT']); }
  else if (venue === 'deribit') { if (spot || upper !== base + '-PERPETUAL') return null; quote = 'USD'; }
  else if (venue === 'coinbase' || venue === 'kucoin') { if (!spot) return null; quote = pair(base, '-'); }
  else if (venue === 'kraken') { if (!spot) return null; quote = pair(base, '/'); }
  else if (venue === 'htx') { if (spot) return null; quote = pair(base, '-', '', ['USDT']); }
  else if (venue === 'bitfinex') { if (!spot) return null; const prefix = upper.startsWith('T') ? 'T' : ''; quote = pair(prefix + base, '', '', ['USD', 'USDT', 'UST', 'USDC']); id = 'bitfinex:' + upper.replace(/^T/, ''); if (quote === 'UST') quote = 'USDT'; }
  else if (venue === 'bitmex') {
    // The existing adapter does not establish ETHUSD's quanto sizing basis.
    if (spot || base !== 'BTC' || upper !== 'XBTUSD') return null; quote = 'USD';
  } else if (venue === 'cryptocom') { if (spot) return null; quote = pair(base, '', '-PERP', ['USD', 'USDT']); }
  else if (venue === 'bitstamp') { if (!spot) return null; quote = pair(base); }
  else if (venue === 'whitebit') { if (!spot) return null; quote = pair(base, '_'); }
  else if (venue === 'phemex') { if (!spot || !native.startsWith('s')) return null; quote = pair('S' + base); id = 'phemex:' + native; }
  else if (venue === 'dydx') { if (spot) return null; quote = pair(base, '-', '', ['USD']); }
  else if (venue === 'aster') { if (spot) return null; quote = pair(base, '', '', ['USDT']); }
  if (!quote) return null;
  return { venue, feedId: venue === 'hyperliquid' ? 'hl-l2Book' : venue + '-depth', nativeSymbol: native, instrumentId: id,
    base, quote, marketType, metadataRequired: true };
}
function primaryIdentity(product: unknown): ProductIdentity | null {
  const row = ownValues(product, PRODUCT_KEYS); if (!row) return null;
  const venue = PUBLIC_ORDERBOOK_VENUE_IDS.find(id => row.venue === id); if (!venue) return null;
  if (row.exchange !== undefined && row.exchange !== venue || row.isDelisted === true
    || row.isDelisted !== undefined && typeof row.isDelisted !== 'boolean') return null;
  if (row.status !== undefined && row.status !== null && !['online', 'open', 'trading', 'live'].includes(String(row.status).toLowerCase())) return null;
  const native = row.nativeSymbol ?? row.symbol, id = row.instrumentId ?? row.id;
  const rawBase = row.base, quote = row.quote, marketType = row.marketType;
  const base = (venue === 'bitmex' || venue === 'kraken') && (rawBase === 'XBT' || rawBase === 'XXBT') ? 'BTC' : rawBase;
  if ((base !== 'BTC' && base !== 'ETH') || typeof quote !== 'string' || !STABLE_QUOTES.includes(quote)
    || typeof native !== 'string' || native.length < 1 || native.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(native)
    || typeof id !== 'string' || id.length > 96 || (marketType !== 'spot' && marketType !== 'perpetual')
    || row.id !== undefined && row.instrumentId !== undefined && row.id !== row.instrumentId) return null;
  if (row.inverse !== undefined && typeof row.inverse !== 'boolean') return null;
  const family = familyFor(row, venue, native.toUpperCase(), marketType, quote);
  const options: LiveFeedStartOptions = { binanceFamily: family === 'coinm' ? 'coinm' : 'usdm',
    bybitCategory: family === 'spot' ? 'spot' : family === 'inverse' ? 'inverse' : 'linear' };
  const stream = streamFor(venue, native, base, marketType, options);
  if (!stream || stream.instrumentId !== id || stream.quote !== quote) return null;
  if ((venue === 'binance' && family === 'coinm' || venue === 'bybit' && family === 'inverse' || venue === 'okx' && family === 'swap' && quote === 'USD') && row.inverse === false) return null;
  if ((venue === 'bybit' && family === 'linear' || venue === 'binance' && family !== 'coinm' || venue === 'bitget' || marketType === 'spot') && row.inverse === true) return null;
  if (venue === 'bybit' && row.contractType !== undefined && row.contractType !== null && row.contractType !== (family === 'inverse' ? 'InversePerpetual' : family === 'linear' ? 'LinearPerpetual' : '')) return null;
  return { venue, base, quote, native, id, marketType, family };
}
/** Plan requests for one authoritative manager/catalog product. This grants no
 * active-product, transport, quantity-conversion or byte authority. The manager
 * must reverify each selected native product before publishing any complete book.
 * Unknown catalog fields are never copied or read; input/configuration is unchanged. */
export function planPublicOrderbookSelection(product: unknown, selectedVenues: unknown = PUBLIC_ORDERBOOK_DEFAULT_VENUES,
  baseline: LiveFeedStartOptions = {}): PublicOrderbookSelectionPlan {
  try {
    const venues = selectedIds(selectedVenues); if (!venues) return fail(`Select 0..${PUBLIC_ORDERBOOK_MAX_SELECTED} exact public orderbook venue IDs without duplicates`);
    for (const venue of venues) if (!CATALOG.find(item => item.id === venue)!.supported) return fail('Public depth is unsupported for this venue', venue);
    const identity = primaryIdentity(product); if (!identity) return fail('Selected product has unavailable or incompatible active BTC/ETH USD/stable native metadata');
    const safe = safeBaseline(baseline); if (!safe) return fail('Public feed configuration is unsafe or exceeds its bounded shell');
    let options: LiveFeedStartOptions;
    if (identity.family !== null) options = publicMarketFeedOptions({ venue: identity.venue, discoveryFamily: identity.family, nativeSymbol: identity.native,
      instrumentId: identity.id, base: identity.base, quote: identity.quote, marketType: identity.marketType, isDelisted: false }, safe);
    else {
      options = rebaseLiveFeedConfiguration(identity.base, safe);
      const key = identity.venue + 'Symbol'; Object.defineProperty(options, key, { value: identity.native, enumerable: true, writable: true, configurable: true });
    }
    for (const venue of OPTIONAL_VENUES) Object.defineProperty(options, venue + 'Enabled', { value: venues.includes(venue), enumerable: true, writable: true, configurable: true });
    options.selectedOrderbookVenues = Object.freeze([...venues]);
    const streams: PublicOrderbookStreamPlan[] = [];
    for (const venue of venues) {
      const symbolKey = venue === 'hyperliquid' ? 'hlNativeCoin' : venue + 'Symbol';
      const native: unknown = (options as Record<string, unknown>)[symbolKey] ?? (venue === 'hyperliquid' ? identity.base : null);
      if (typeof native !== 'string' || !native || native.length > 64) return fail('Selected venue native symbol is unavailable', venue);
      const marketType = venue === 'binance' ? options.binanceMarketType : venue === 'bybit' ? options.bybitCategory === 'spot' ? 'spot' : 'perpetual'
        : venue === 'okx' ? options.okxMarketType : venue === 'bitget' ? options.bitgetMarketType
        : ['coinbase', 'kraken', 'kucoin', 'bitfinex', 'bitstamp', 'whitebit', 'phemex'].includes(venue) ? 'spot' : 'perpetual';
      if (marketType !== 'spot' && marketType !== 'perpetual') return fail('Selected venue native family is unavailable', venue);
      const stream = streamFor(venue, native, identity.base, marketType, options);
      if (!stream) return fail(venue === 'bitmex' && identity.base === 'ETH' ? 'BitMEX ETH quanto/linear sizing basis is not implemented by this bounded planner' : 'Selected venue native symbol/family is unavailable for this base', venue);
      streams.push(Object.freeze(stream));
    }
    return { ok: true, base: identity.base, venues: Object.freeze(venues), options, streams: Object.freeze(streams) };
  } catch (error) { return fail(error instanceof Error ? error.message : 'Invalid public orderbook metadata or configuration'); }
}
