import { ORDERBOOK_VENUE_MAX_SELECTED } from '../core/orderbook-venue-controls.mts';
import type { LiveFeedStartOptions } from './live-feeds.mts';
import { hyperliquidCoin, hyperliquidNativeCoin } from '../adapters/hyperliquid.mts';

function choice<T extends string>(name: string, value: string | undefined, choices: readonly T[], fallback: T): T {
  const selected = (value ?? fallback).trim().toLowerCase();
  const result = choices.find(candidate => candidate === selected);
  if (!result) throw new RangeError(`Invalid ${name}: ${value}; expected ${choices.join(', ')}`);
  return result;
}
function enabled(name: string, value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return choice(name, value, ['true', 'false'] as const, fallback ? 'true' : 'false') === 'true';
}
function coin(value: string): string {
  const selected = hyperliquidCoin(value);
  if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(selected)) throw new TypeError('Invalid configured public base coin');
  return selected;
}
function nativeSymbol(name: string, value: string | undefined, fallback: string): string {
  const selected = (value ?? fallback).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,63}$/.test(selected)) throw new TypeError(`Invalid ${name}`);
  return selected;
}

/** Canonical configured peers are requests, not evidence of an active product.
 * Every live manager still verifies its native metadata and transport budget. */
function defaults(base: string, binanceFamily: 'usdm' | 'coinm', binanceMarketType: 'spot' | 'perpetual',
  bybitCategory: 'linear' | 'spot' | 'inverse', okxMarketType: 'spot' | 'perpetual', bitgetMarketType: 'spot' | 'perpetual'): LiveFeedStartOptions {
  return {
    coin: base, binanceFamily, binanceMarketType,
    binanceSymbol: base + (binanceFamily === 'coinm' ? 'USD_PERP' : 'USDT'),
    bybitEnabled: true, bybitCategory, bybitSymbol: base + (bybitCategory === 'inverse' ? 'USD' : 'USDT'),
    okxEnabled: true, okxMarketType, okxSymbol: base + (okxMarketType === 'spot' ? '-USDT' : '-USDT-SWAP'),
    bitgetEnabled: false, bitgetMarketType, bitgetSymbol: base + 'USDT',
    gateioEnabled: false, gateioSymbol: base + '_USDT',
    deribitEnabled: false, deribitSymbol: base + '-PERPETUAL',
    coinbaseEnabled: false, coinbaseSymbol: base + '-USD',
    krakenEnabled: false, krakenSymbol: base + '/USD',
    kucoinEnabled: false, kucoinSymbol: base + '-USDT',
    mexcEnabled: false, mexcSymbol: base + '_USDT',
    htxEnabled: false, htxSymbol: base + '-USDT',
    bitfinexEnabled: false, bitfinexSymbol: base + 'USD',
    bitmexEnabled: false, bitmexSymbol: (base === 'BTC' ? 'XBT' : base) + 'USD',
    cryptocomEnabled: false, cryptocomSymbol: base + 'USD-PERP',
    bitstampEnabled: false, bitstampSymbol: (base + 'USD').toLowerCase(),
    whitebitEnabled: false, whitebitSymbol: base + '_USDT',
    phemexEnabled: false, phemexSymbol: 's' + base + 'USDT',
    dydxEnabled: false, dydxSymbol: base + '-USD',
    asterEnabled: false, asterSymbol: base + 'USDT',
  };
}

/** Central public-feed configuration: four major venues by default, additional
 * implemented venues by explicit flag. Explicit false always disables a peer. */
export function liveFeedConfiguration(env: NodeJS.ProcessEnv = process.env): LiveFeedStartOptions {
  const base = coin(env.HL_DEFAULT_COIN ?? 'BTC');
  const binanceFamily = choice('BINANCE_FAMILY', env.BINANCE_FAMILY, ['usdm', 'coinm'] as const, 'usdm');
  const binanceMarketType = choice('BINANCE_MARKET_TYPE', env.BINANCE_MARKET_TYPE, ['perpetual', 'spot'] as const, 'perpetual');
  if (binanceFamily === 'coinm' && binanceMarketType === 'spot') throw new RangeError('BINANCE_FAMILY=coinm does not expose spot markets');
  const bybitCategory = choice('BYBIT_CATEGORY', env.BYBIT_CATEGORY, ['linear', 'spot', 'inverse'] as const, 'linear');
  const okxMarketType = choice('OKX_MARKET_TYPE', env.OKX_MARKET_TYPE, ['perpetual', 'spot'] as const, 'perpetual');
  const bitgetMarketType = choice('BITGET_MARKET_TYPE', env.BITGET_MARKET_TYPE, ['perpetual', 'spot'] as const, 'perpetual');
  const standard = defaults(base, binanceFamily, binanceMarketType, bybitCategory, okxMarketType, bitgetMarketType);
  const configured: LiveFeedStartOptions = {
    ...standard,
    ...(env.HL_NATIVE_COIN == null ? {} : { hlNativeCoin: hyperliquidNativeCoin(base, env.HL_NATIVE_COIN) }),
    binanceSymbol: nativeSymbol('BINANCE_DEFAULT_SYMBOL', env.BINANCE_DEFAULT_SYMBOL, base + (binanceFamily === 'coinm' ? 'USD_PERP' : 'USDT')),
    bybitEnabled: enabled('BYBIT_ENABLED', env.BYBIT_ENABLED, true),
    bybitSymbol: nativeSymbol('BYBIT_DEFAULT_SYMBOL', env.BYBIT_DEFAULT_SYMBOL, base + (bybitCategory === 'inverse' ? 'USD' : 'USDT')),
    okxEnabled: enabled('OKX_ENABLED', env.OKX_ENABLED, true),
    okxSymbol: nativeSymbol('OKX_DEFAULT_SYMBOL', env.OKX_DEFAULT_SYMBOL, base + (okxMarketType === 'spot' ? '-USDT' : '-USDT-SWAP')),
    bitgetEnabled: enabled('BITGET_ENABLED', env.BITGET_ENABLED), bitgetSymbol: nativeSymbol('BITGET_DEFAULT_SYMBOL', env.BITGET_DEFAULT_SYMBOL, base + 'USDT'),
    gateioEnabled: enabled('GATEIO_ENABLED', env.GATEIO_ENABLED), gateioSymbol: nativeSymbol('GATEIO_DEFAULT_SYMBOL', env.GATEIO_DEFAULT_SYMBOL, base + '_USDT'),
    deribitEnabled: enabled('DERIBIT_ENABLED', env.DERIBIT_ENABLED), deribitSymbol: nativeSymbol('DERIBIT_DEFAULT_SYMBOL', env.DERIBIT_DEFAULT_SYMBOL, base + '-PERPETUAL'),
    coinbaseEnabled: enabled('COINBASE_ENABLED', env.COINBASE_ENABLED), coinbaseSymbol: nativeSymbol('COINBASE_DEFAULT_SYMBOL', env.COINBASE_DEFAULT_SYMBOL, base + '-USD'),
    krakenEnabled: enabled('KRAKEN_ENABLED', env.KRAKEN_ENABLED), krakenSymbol: nativeSymbol('KRAKEN_DEFAULT_SYMBOL', env.KRAKEN_DEFAULT_SYMBOL, base + '/USD'),
    kucoinEnabled: enabled('KUCOIN_ENABLED', env.KUCOIN_ENABLED), kucoinSymbol: nativeSymbol('KUCOIN_DEFAULT_SYMBOL', env.KUCOIN_DEFAULT_SYMBOL, base + '-USDT'),
    mexcEnabled: enabled('MEXC_ENABLED', env.MEXC_ENABLED), mexcSymbol: nativeSymbol('MEXC_DEFAULT_SYMBOL', env.MEXC_DEFAULT_SYMBOL, base + '_USDT'),
    htxEnabled: enabled('HTX_ENABLED', env.HTX_ENABLED), htxSymbol: nativeSymbol('HTX_DEFAULT_SYMBOL', env.HTX_DEFAULT_SYMBOL, base + '-USDT'),
    bitfinexEnabled: enabled('BITFINEX_ENABLED', env.BITFINEX_ENABLED), bitfinexSymbol: nativeSymbol('BITFINEX_DEFAULT_SYMBOL', env.BITFINEX_DEFAULT_SYMBOL, base + 'USD'),
    bitmexEnabled: enabled('BITMEX_ENABLED', env.BITMEX_ENABLED), bitmexSymbol: nativeSymbol('BITMEX_DEFAULT_SYMBOL', env.BITMEX_DEFAULT_SYMBOL, (base === 'BTC' ? 'XBT' : base) + 'USD'),
    cryptocomEnabled: enabled('CRYPTOCOM_ENABLED', env.CRYPTOCOM_ENABLED), cryptocomSymbol: nativeSymbol('CRYPTOCOM_DEFAULT_SYMBOL', env.CRYPTOCOM_DEFAULT_SYMBOL, base + 'USD-PERP'),
    bitstampEnabled: enabled('BITSTAMP_ENABLED', env.BITSTAMP_ENABLED), bitstampSymbol: nativeSymbol('BITSTAMP_DEFAULT_SYMBOL', env.BITSTAMP_DEFAULT_SYMBOL, (base + 'USD').toLowerCase()),
    whitebitEnabled: enabled('WHITEBIT_ENABLED', env.WHITEBIT_ENABLED), whitebitSymbol: nativeSymbol('WHITEBIT_DEFAULT_SYMBOL', env.WHITEBIT_DEFAULT_SYMBOL, base + '_USDT'),
    phemexEnabled: enabled('PHEMEX_ENABLED', env.PHEMEX_ENABLED), phemexSymbol: nativeSymbol('PHEMEX_DEFAULT_SYMBOL', env.PHEMEX_DEFAULT_SYMBOL, 's' + base + 'USDT'),
    dydxEnabled: enabled('DYDX_ENABLED', env.DYDX_ENABLED), dydxSymbol: nativeSymbol('DYDX_DEFAULT_SYMBOL', env.DYDX_DEFAULT_SYMBOL, base + '-USD'),
    asterEnabled: enabled('ASTER_ENABLED', env.ASTER_ENABLED), asterSymbol: nativeSymbol('ASTER_DEFAULT_SYMBOL', env.ASTER_DEFAULT_SYMBOL, base + 'USDT'),
  };
  const selected = ['hyperliquid', 'binance'];
  for (const venue of ['bybit', 'okx', 'bitget', 'gateio', 'deribit', 'coinbase', 'kraken', 'kucoin', 'mexc', 'htx',
    'bitfinex', 'bitmex', 'cryptocom', 'bitstamp', 'whitebit', 'phemex', 'dydx', 'aster'] as const)
    if (configured[`${venue}Enabled`] === true) selected.push(venue);
  if (selected.length > ORDERBOOK_VENUE_MAX_SELECTED)
    throw new RangeError(`Public orderbook startup requests ${selected.length} venues; select at most ${ORDERBOOK_VENUE_MAX_SELECTED} enabled venues`);
  configured.selectedOrderbookVenues = Object.freeze(selected);
  return configured;
}

const STABLE_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'USD'] as const;
/** Preserve only a supported native stable-quote shape, never a foreign base.
 * An unusual old symbol becomes the adapter's default for the newly selected
 * asset; the selected catalog product itself is overridden exactly by caller. */
function rebasePair(value: string | null | undefined, base: string, fallback: string, separator = '', suffix = '',
  prefix = '', quotes: readonly string[] = STABLE_QUOTES, lower = false): string | null {
  if (value === null) return null;
  let native = value?.trim().toUpperCase();
  if (native == null) return fallback;
  if (prefix && native.startsWith(prefix.toUpperCase())) native = native.slice(prefix.length);
  else if (prefix) return fallback;
  const quote = quotes.find(candidate => native!.endsWith(separator + candidate + suffix));
  if (!quote) return fallback;
  const oldBase = native.slice(0, -(separator + quote + suffix).length);
  if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(oldBase)) return fallback;
  const rebased = prefix + base + separator + quote + suffix;
  return lower ? rebased.toLowerCase() : rebased;
}

/** Pure same-asset selection rebasing. Flags, public families and bounded
 * transport/grouping controls survive; obsolete native peer bases do not. */
export function rebaseLiveFeedConfiguration(selectedCoin: string, baseline: LiveFeedStartOptions = {}): LiveFeedStartOptions {
  const base = coin(selectedCoin);
  const binanceFamily = choice('BINANCE_FAMILY', baseline.binanceFamily, ['usdm', 'coinm'] as const, 'usdm');
  const binanceMarketType = choice('BINANCE_MARKET_TYPE', baseline.binanceMarketType, ['perpetual', 'spot'] as const, 'perpetual');
  if (binanceFamily === 'coinm' && binanceMarketType === 'spot') throw new RangeError('BINANCE_FAMILY=coinm does not expose spot markets');
  const bybitCategory = choice('BYBIT_CATEGORY', baseline.bybitCategory, ['linear', 'spot', 'inverse'] as const, 'linear');
  const okxMarketType = choice('OKX_MARKET_TYPE', baseline.okxMarketType, ['perpetual', 'spot'] as const, 'perpetual');
  const bitgetMarketType = choice('BITGET_MARKET_TYPE', baseline.bitgetMarketType, ['perpetual', 'spot'] as const, 'perpetual');
  const standard = defaults(base, binanceFamily, binanceMarketType, bybitCategory, okxMarketType, bitgetMarketType);
  const options: LiveFeedStartOptions = { ...standard, ...baseline, coin: base, binanceFamily, binanceMarketType, bybitCategory, okxMarketType, bitgetMarketType,
    binanceSymbol: rebasePair(baseline.binanceSymbol, base, String(standard.binanceSymbol), '', binanceFamily === 'coinm' ? '_PERP' : '', '', binanceFamily === 'coinm' ? ['USD'] : STABLE_QUOTES) ?? String(standard.binanceSymbol),
    bybitSymbol: rebasePair(baseline.bybitSymbol, base, String(standard.bybitSymbol), '', '', '', bybitCategory === 'inverse' ? ['USD'] : bybitCategory === 'linear' ? ['USDT', 'USDC'] : STABLE_QUOTES),
    okxSymbol: rebasePair(baseline.okxSymbol, base, String(standard.okxSymbol), '-', okxMarketType === 'spot' ? '' : '-SWAP'),
    bitgetSymbol: rebasePair(baseline.bitgetSymbol, base, String(standard.bitgetSymbol), '', '', '', bitgetMarketType === 'spot' ? STABLE_QUOTES : ['USDT']),
    gateioSymbol: rebasePair(baseline.gateioSymbol, base, String(standard.gateioSymbol), '_', '', '', ['USDT']),
    deribitSymbol: baseline.deribitSymbol === null ? null : base + '-PERPETUAL',
    coinbaseSymbol: rebasePair(baseline.coinbaseSymbol, base, String(standard.coinbaseSymbol), '-'),
    krakenSymbol: rebasePair(baseline.krakenSymbol == null ? baseline.krakenSymbol : baseline.krakenSymbol.replaceAll('-', '/'), base, String(standard.krakenSymbol), '/'),
    kucoinSymbol: rebasePair(baseline.kucoinSymbol == null ? baseline.kucoinSymbol : baseline.kucoinSymbol.replaceAll('_', '-'), base, String(standard.kucoinSymbol), '-'),
    mexcSymbol: rebasePair(baseline.mexcSymbol == null ? baseline.mexcSymbol : baseline.mexcSymbol.replaceAll('-', '_'), base, String(standard.mexcSymbol), '_', '', '', ['USDT']),
    htxSymbol: rebasePair(baseline.htxSymbol == null ? baseline.htxSymbol : baseline.htxSymbol.replaceAll('_', '-').replaceAll('/', '-'), base, String(standard.htxSymbol), '-', '', '', ['USDT']),
    bitfinexSymbol: rebasePair(baseline.bitfinexSymbol == null ? baseline.bitfinexSymbol : baseline.bitfinexSymbol.replace(/^t/i, '').replaceAll('/', '').replaceAll('-', '').replaceAll('_', ''), base, String(standard.bitfinexSymbol)),
    bitmexSymbol: rebasePair(baseline.bitmexSymbol, base === 'BTC' ? 'XBT' : base, String(standard.bitmexSymbol), '', '', '', ['USDT', 'USD']),
    cryptocomSymbol: rebasePair(baseline.cryptocomSymbol, base, String(standard.cryptocomSymbol), '', '-PERP', '', ['USDT', 'USD']),
    bitstampSymbol: rebasePair(baseline.bitstampSymbol == null ? baseline.bitstampSymbol : baseline.bitstampSymbol.replaceAll('/', '').replaceAll('-', '').replaceAll('_', ''), base, String(standard.bitstampSymbol), '', '', '', STABLE_QUOTES, true),
    whitebitSymbol: rebasePair(baseline.whitebitSymbol, base, String(standard.whitebitSymbol), '_'),
    phemexSymbol: rebasePair(baseline.phemexSymbol, base, String(standard.phemexSymbol), '', '', 's'),
    dydxSymbol: rebasePair(baseline.dydxSymbol == null ? baseline.dydxSymbol : baseline.dydxSymbol.replaceAll('_', '-'), base, String(standard.dydxSymbol), '-', '', '', ['USD']),
    asterSymbol: rebasePair(baseline.asterSymbol, base, String(standard.asterSymbol), '', '', '', ['USDT']),
  };
  if (baseline.hlNativeCoin != null && hyperliquidCoin(baseline.hlNativeCoin) !== base) delete options.hlNativeCoin;
  return options;
}
