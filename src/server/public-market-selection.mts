import { ORDERBOOK_VENUE_MAX_SELECTED } from '../core/orderbook-venue-controls.mts';
import type { RuntimeMarket } from '../domain/runtime-state.mts';
import type { LiveFeedStartOptions } from './live-feeds.mts';
import { validatePublicProductDiscoverySelection } from './product-discovery.mts';
import { hyperliquidCoin } from '../adapters/hyperliquid.mts';
import { binanceInstrumentId } from '../adapters/binance.mts';
import { bybitInstrumentId } from '../adapters/bybit.mts';
import { okxInstrumentId } from '../adapters/okx.mts';
import { bitgetInstrumentId } from '../adapters/bitget.mts';
import { rebaseLiveFeedConfiguration } from './live-feed-config.mts';

const STABLE_PRICE_QUOTES = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI']);

/** Select one verified catalog product and compatible default peers. Catalog
 * discovery alone never subscribes every discovered market. */
export interface PublicMarketFeedValidationContext { context: 'activation' | 'discovery'; }

export function publicMarketFeedOptions(product: RuntimeMarket, baseline: LiveFeedStartOptions = {}, validation: PublicMarketFeedValidationContext = { context: 'activation' }): LiveFeedStartOptions {
  const selection = validatePublicProductDiscoverySelection(product.venue, product.discoveryFamily);
  const native = product.nativeSymbol;
  const nativeBase = product.base;
  const base = selection.venue === 'hyperliquid' && typeof nativeBase === 'string' ? hyperliquidCoin(nativeBase) : nativeBase;
  const id = product.instrumentId ?? product.id;
  if (typeof native !== 'string' || !native || native.length > 64 || typeof base !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(base)
      || typeof id !== 'string' || product.isDelisted !== false || !['spot', 'perpetual'].includes(String(product.marketType)))
    throw new TypeError('Selected public product has invalid active native metadata');
  if (selection.family !== 'spot' && product.marketType !== 'perpetual' || selection.family === 'spot' && product.marketType !== 'spot')
    throw new TypeError('Selected public product family and market type disagree');
  // The application shares a USD/stable price axis and Hyperliquid mark basis.
  // A notional conversion alone cannot rebase native BTC/EUR candle prices.
  // Keep such products discoverable, but refuse activation before any runtime
  // selection, provider-generation or mark-session mutation.
  const quote = typeof product.quote === 'string' ? product.quote.trim().toUpperCase() : '';
  if (validation.context !== 'discovery' && !STABLE_PRICE_QUOTES.has(quote))
    throw new TypeError('Native quote ' + (quote || 'unknown') + ' activation is unsupported until a coherent USD/stable price basis is available');
  let expectedId: string;
  if (selection.venue === 'hyperliquid') expectedId = `hyperliquid:${hyperliquidCoin(native)}-PERP`;
  else if (selection.venue === 'binance') expectedId = binanceInstrumentId(native, selection.family === 'spot' ? 'spot' : 'perpetual', selection.family === 'coinm' ? 'coinm' : 'usdm');
  else if (selection.venue === 'bybit') expectedId = bybitInstrumentId(native, selection.family);
  else if (selection.venue === 'okx') expectedId = okxInstrumentId(native);
  else expectedId = bitgetInstrumentId(native, selection.family);
  if (id !== expectedId) throw new TypeError('Selected public product identity disagrees with its family');
  if (selection.venue === 'hyperliquid' && native.toUpperCase() !== base.toUpperCase()) throw new TypeError('Namespaced Hyperliquid discovery is not configured');
  const options = rebaseLiveFeedConfiguration(base, baseline);
  if (selection.venue === 'hyperliquid') options.hlNativeCoin = native;
  if (selection.venue === 'binance') {
    options.binanceSymbol = native; options.binanceFamily = selection.family === 'coinm' ? 'coinm' : 'usdm';
    options.binanceMarketType = selection.family === 'spot' ? 'spot' : 'perpetual';
  } else if (selection.venue === 'bybit') {
    options.bybitEnabled = true; options.bybitSymbol = native; options.bybitCategory = selection.family;
  } else if (selection.venue === 'okx') {
    options.okxEnabled = true; options.okxSymbol = native; options.okxMarketType = selection.family === 'spot' ? 'spot' : 'perpetual';
  } else if (selection.venue === 'bitget') {
    options.bitgetEnabled = true; options.bitgetSymbol = native; options.bitgetMarketType = selection.family === 'spot' ? 'spot' : 'perpetual';
  }
  return options;
}


/** Borrowed configured manager specs; this is configuration acceptance only.
 * Native metadata, complete books and live/session status remain manager-owned. */
export interface PublicMarketFeedSelectionSpec {
  readonly venue: string; readonly channel: string; readonly instrumentId?: string; readonly request?: unknown;
}
export type PublicMarketFeedAcceptance = 'selected-native' | 'hyperliquid-reference';
function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function sameBaseHyperliquidReference(spec: PublicMarketFeedSelectionSpec, base: string): boolean {
  if (spec.venue !== 'hyperliquid' || !['activeAssetCtx', 'candle', 'trades'].includes(spec.channel)) return false;
  const expected = `hyperliquid:${base}-PERP`;
  if (spec.instrumentId !== undefined && spec.instrumentId !== expected) return false;
  if (spec.request === undefined) return spec.instrumentId === expected;
  // The actual activeAssetCtx spec carries its native coin in the request,
  // rather than an instrumentId. Inspect only data descriptors, never getters,
  // and reject any request that contradicts a declared same-base identifier.
  const subscription = ownData(spec.request, 'subscription');
  const native = ownData(subscription, 'coin');
  return ownData(subscription, 'type') === spec.channel && typeof native === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/.test(native) && hyperliquidCoin(native) === base;
}

/** Accept the exact depth mask after start. An excluded optional venue is an
 * asset choice, requiring a configured same-base HL reference; it does not
 * silently enable that ladder or claim a live/admitted native book. */
export function assertPublicMarketFeedSelection(product: RuntimeMarket, options: LiveFeedStartOptions,
  specs: Iterable<PublicMarketFeedSelectionSpec>): PublicMarketFeedAcceptance {
  const verified = publicMarketFeedOptions(product);
  const selection = validatePublicProductDiscoverySelection(product.venue, product.discoveryFamily);
  const id = product.instrumentId ?? product.id;
  const base = verified.coin;
  if (typeof id !== 'string' || typeof base !== 'string' || hyperliquidCoin(options.coin ?? 'BTC') !== base)
    throw new Error('Selected public market has no matching configured reference asset');
  const mask = options.selectedOrderbookVenues;
  if (mask !== undefined && (!Array.isArray(mask) || mask.length > ORDERBOOK_VENUE_MAX_SELECTED
    || mask.some((venue, index) => typeof venue !== 'string' || mask.indexOf(venue) !== index)))
    throw new Error('Selected public market has an invalid exact depth mask');
  let nativeConfigured = false, referenceConfigured = false;
  for (const spec of specs) {
    if (spec.venue === selection.venue && spec.instrumentId === id) nativeConfigured = true;
    if (sameBaseHyperliquidReference(spec, base)) {
      referenceConfigured = true;
      if (selection.venue === 'hyperliquid' && id === `hyperliquid:${base}-PERP`) nativeConfigured = true;
    }
  }
  if (nativeConfigured && (mask === undefined || mask.includes(selection.venue)
      || selection.venue === 'hyperliquid' || selection.venue === 'binance')) return 'selected-native';
  if (mask !== undefined && !mask.includes(selection.venue) && selection.venue !== 'hyperliquid'
      && selection.venue !== 'binance' && referenceConfigured) return 'hyperliquid-reference';
  throw new Error(mask === undefined || mask.includes(selection.venue)
    ? 'Selected public market did not obtain its configured native feed'
    : 'Selected public market has neither its native reference feed nor a same-base Hyperliquid reference');
}
