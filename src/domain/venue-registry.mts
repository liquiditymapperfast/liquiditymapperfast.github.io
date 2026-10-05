import type { BookResolution, CapabilityState, MarketType, VenueCapability, VenueCapabilityKey, VenueHistoryCoverage, VenueRegistryEntry } from './contracts.ts';
/**
 * Runtime venue capability registry. The contract is typed in contracts.ts;
 * unsupported entries are metadata only and never open a feed by themselves.
 */
const futureLevelKeys: readonly VenueCapabilityKey[] = ['liquidationLevels', 'stopLossLevels', 'takeProfitLevels'];
const historyKeys: readonly VenueCapabilityKey[] = ['candleHistory', 'openInterestHistory'];
// `futureLevels` remains a compatibility summary for existing API consumers.
// New consumers must use the three explicit capabilities because their source
// contracts, costs, and coverage can differ.
const keys: readonly VenueCapabilityKey[] = ['products', 'trades', 'l2', 'candles', ...historyKeys.slice(0, 1), 'openInterest', ...historyKeys.slice(1), 'executedLiquidations', ...futureLevelKeys, 'futureLevels'];
const unsupportedReason = 'public adapter is not wired and has no live evidence';
const blockedReason = 'future-level provider is external and not configured';

/** @param {import('./contracts.ts').CapabilityState} state @param {string} [reason] @param {readonly import('./contracts.ts').MarketType[]} [marketTypes] @param {readonly import('./contracts.ts').BookResolution[]} [resolutions] @param {{coverage?: import('./contracts.ts').VenueHistoryCoverage, limits?: string}} [metadata] @returns {import('./contracts.ts').VenueCapability} */
function capability(state: CapabilityState, reason?: string, marketTypes?: readonly MarketType[], resolutions?: readonly BookResolution[], metadata: { coverage?: VenueHistoryCoverage; limits?: string } = {}): VenueCapability {
  return Object.freeze({ state, ...(marketTypes ? { marketTypes: Object.freeze([...marketTypes]) } : {}), ...(resolutions ? { resolutions: Object.freeze([...resolutions]) } : {}), ...(metadata.coverage ? { coverage: metadata.coverage } : {}), ...(metadata.limits ? { limits: metadata.limits } : {}), ...(reason ? { reason } : {}) });
}

/** @param {import('./contracts.ts').CapabilityState} state @param {import('./contracts.ts').VenueHistoryCoverage} coverage @param {string} [reason] @param {readonly import('./contracts.ts').MarketType[]} [marketTypes] @param {readonly import('./contracts.ts').BookResolution[]} [resolutions] @param {string} [limits] @returns {import('./contracts.ts').VenueCapability} */
const historyCapability = (state: CapabilityState, coverage: VenueHistoryCoverage, reason?: string, marketTypes?: readonly MarketType[], resolutions?: readonly BookResolution[], limits?: string) => capability(state, reason, marketTypes, resolutions, { coverage, limits });

/** @param {string} venue @param {string} label @param {import('./contracts.ts').CapabilityState} status @param {readonly import('./contracts.ts').MarketType[]} marketTypes @param {Partial<Record<import('./contracts.ts').VenueCapabilityKey, import('./contracts.ts').VenueCapability>>} capabilities @param {string|undefined} source @returns {VenueRegistryEntry} */
function entry(venue: string, label: string, status: CapabilityState, marketTypes: readonly MarketType[], capabilities: Partial<Record<VenueCapabilityKey, VenueCapability>>, source?: string): VenueRegistryEntry {
  const futureSummary = capabilities.futureLevels ?? capability('unsupported', unsupportedReason);
  const complete = Object.fromEntries(keys.map((key) => [key, capabilities[key] ?? (futureLevelKeys.includes(key) ? futureSummary : historyKeys.includes(key) ? historyCapability('unsupported', 'none', unsupportedReason) : capability('unsupported', unsupportedReason))])) as Record<VenueCapabilityKey, VenueCapability>;
  return Object.freeze({ venue, label, status, marketTypes: Object.freeze([...marketTypes]), capabilities: Object.freeze(complete), ...(source ? { source } : {}) });
}

/** @param {readonly import('./contracts.ts').MarketType[]} marketTypes */
const supportedPublic = (marketTypes: readonly MarketType[]) => capability('supported', undefined, marketTypes);
const unsupportedPublic = () => capability('unsupported', unsupportedReason);

/** @type {readonly VenueRegistryEntry[]} */
export const VENUE_REGISTRY: readonly VenueRegistryEntry[] = Object.freeze([
  entry('hyperliquid', 'Hyperliquid', 'supported', ['perpetual'], {
    products: capability('supported', 'bounded public base perpetual discovery preserves active native names; spot and namespaced HIP-3 discovery are not wired', ['perpetual']), trades: supportedPublic(['perpetual']),
    l2: capability('supported', undefined, ['perpetual'], ['native', 'coarse']),
    candles: supportedPublic(['perpetual']),
    candleHistory: historyCapability('supported', 'public-backfill', undefined, ['perpetual'], undefined, 'bounded candleSnapshot history'),
    openInterest: supportedPublic(['perpetual']),
    openInterestHistory: historyCapability('supported', 'local-observed', 'activeAssetCtx observations are retained locally; Hyperliquid public metadata does not provide historical OI backfill', ['perpetual'], undefined, 'starts at first local observation; gaps and receipt-time provenance remain visible'),
    executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/hyperliquid.mts'),
  entry('binance', 'Binance', 'supported', ['spot', 'perpetual'], {
    products: capability('supported', 'bounded public USDT spot/USD-M and verified COIN-M inverse perpetual discovery; delivery and broader quote families are not wired', ['spot', 'perpetual']), trades: capability('supported', 'configured USDT spot/USD-M and verified USD-valued COIN-M inverse perpetuals only; broader quote families are not wired', ['spot', 'perpetual']),
    l2: capability('supported', undefined, ['spot', 'perpetual'], ['native']),
    candles: supportedPublic(['spot', 'perpetual']),
    candleHistory: historyCapability('supported', 'public-backfill', 'configured symbols only', ['spot', 'perpetual'], undefined, 'public klines window; bounded by endpoint retention and request limit'),
    openInterest: capability('supported', 'spot markets do not expose open interest; perpetual endpoint is supported', ['perpetual']),
    openInterestHistory: historyCapability('supported', 'public-backfill', 'spot markets do not expose open interest history; perpetual statistics endpoint is supported', ['perpetual'], undefined, '5m default; 500-sample startup window; 500-row pages; max 5,000; endpoint retention applies'),
    executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/binance.mts'),
  entry('bybit', 'Bybit', 'supported', ['spot', 'perpetual'], {
    products: capability('supported', 'bounded public spot, USDT/USDC linear and inverse perpetual discovery; delivery/options are not wired', ['spot', 'perpetual']), trades: unsupportedPublic(), l2: capability('supported', 'configured spot, linear and inverse perpetual orderbook.1000; numeric predecessor continuity remains unproven; delivery/options are not wired', ['spot', 'perpetual'], ['native']), candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason),
  }, 'src/adapters/bybit.mts; AGGR reference: src/worker/exchanges/bybit.ts'),
  entry('okx', 'OKX', 'supported', ['spot', 'perpetual'], {
    products: capability('supported', 'bounded public spot and linear/inverse SWAP discovery; dated futures/options are not wired', ['spot', 'perpetual']), trades: unsupportedPublic(), l2: capability('supported', 'configured metadata-verified spot and SWAP books', ['spot', 'perpetual'], ['native']), candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/okx.mts'),
  entry('bitget', 'Bitget', 'supported', ['spot', 'perpetual'], {
    products: capability('supported', 'bounded public UTA spot/USDT-futures discovery; margin, COIN/USDC futures and broader categories are not wired', ['spot', 'perpetual']), trades: unsupportedPublic(), l2: capability('supported', 'configured UTA spot/USDT-futures books use documented native base amounts; other futures categories are not wired', ['spot', 'perpetual'], ['native']), candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/bitget.mts'),
  entry('gateio', 'Gate.io', 'supported', ['perpetual'], {
    products: unsupportedPublic(), trades: unsupportedPublic(),
    l2: capability('supported', undefined, ['perpetual'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/gateio.mts; AGGR reference: src/worker/exchanges/gateio.ts'),
  entry('deribit', 'Deribit', 'supported', ['perpetual', 'delivery'], {
    products: unsupportedPublic(), trades: unsupportedPublic(),
    l2: capability('supported', 'configured grouped full snapshots; the live manager uses group 10, depth 20, interval 100ms', ['perpetual', 'delivery'], ['coarse'], { limits: 'finite partial depth; no native/delta stream is opened by the live manager' }),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['perpetual', 'delivery']),
  }, 'src/adapters/deribit.mts; AGGR reference: src/worker/exchanges/deribit.ts'),
  entry('coinbase', 'Coinbase', 'supported', ['spot'], {
    products: capability('unsupported', 'adapter currently uses configured products; product discovery is not wired', ['spot']),
    trades: unsupportedPublic(), l2: capability('supported', 'Coinbase level2 guarantees ordered delivery but does not expose numeric sequence tokens', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['spot']),
  }, 'src/adapters/coinbase.mts'),
  entry('kraken', 'Kraken', 'supported', ['spot'], {
    products: capability('unsupported', 'adapter currently uses configured products; product discovery is not wired', ['spot']),
    trades: unsupportedPublic(), l2: capability('supported', 'Kraken spot v2 book provides ordered WebSocket updates with CRC32 checksum validation and no numeric sequence token', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['spot']),
  }, 'src/adapters/kraken.mts'),
  entry('kucoin', 'KuCoin', 'supported', ['spot'], {
    products: capability('unsupported', 'adapter currently uses configured products; product discovery is not wired', ['spot']),
    trades: unsupportedPublic(), l2: capability('supported', 'KuCoin spot Level-50 WebSocket provides complete provider snapshots without a numeric sequence token', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['spot']),
  }, 'src/adapters/kucoin.mts'),
  entry('mexc', 'MEXC', 'supported', ['perpetual'], {
    products: capability('unsupported', 'adapter currently uses configured contracts; product discovery is not wired', ['perpetual']),
    trades: unsupportedPublic(), l2: capability('supported', 'MEXC contract WebSocket full-depth channel provides bounded complete snapshots with provider version tokens', ['perpetual'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/mexc.mts'),
  entry('htx', 'HTX', 'supported', ['perpetual'], {
    products: capability('unsupported', 'adapter currently uses configured contracts; product discovery is not wired', ['perpetual']),
    trades: unsupportedPublic(), l2: capability('supported', 'HTX USDT swap WebSocket depth.step6 provides bounded complete snapshots with provider version tokens', ['perpetual'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/htx.mts'),
  entry('bitfinex', 'Bitfinex', 'supported', ['spot'], {
    products: capability('unsupported', 'adapter currently uses configured pairs; product discovery is not wired', ['spot']),
    trades: unsupportedPublic(), l2: capability('supported', 'Bitfinex spot book provides complete snapshots, updates, and optional signed CRC32 checksums', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(), futureLevels: capability('externallyBlocked', blockedReason, ['spot']),
  }, 'src/adapters/bitfinex.mts'),
  entry('bitmex', 'BitMEX', 'supported', ['perpetual'], {
    products: capability('unsupported', 'adapter currently uses configured instruments; product discovery is not wired', ['perpetual']),
    trades: unsupportedPublic(),
    l2: capability('supported', 'BitMEX orderBookL2_25 provides provider-ordered contract snapshots and table diffs', ['perpetual'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/bitmex.mts'),
  entry('cryptocom', 'Crypto.com', 'supported', ['perpetual'], {
    products: capability('supported', 'public/get-instruments metadata is bounded to the configured perpetual instrument', ['perpetual']),
    trades: unsupportedPublic(),
    l2: capability('supported', 'Crypto.com book.10/book.50 provides provider-ordered perpetual snapshots and pu/u incremental updates', ['perpetual'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/cryptocom.mts'),
  entry('bitstamp', 'Bitstamp', 'supported', ['spot'], {
    products: capability('supported', 'public markets metadata is available; product discovery remains configured-symbol scoped', ['spot']),
    trades: unsupportedPublic(),
    l2: capability('supported', 'Bitstamp order_book channel provides complete provider snapshots without a numeric sequence token', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['spot']),
  }, 'src/adapters/bitstamp.mts'),
  entry('whitebit', 'WhiteBIT', 'supported', ['spot'], {
    products: capability('supported', 'public markets metadata is available; product discovery remains configured-symbol scoped', ['spot']),
    trades: unsupportedPublic(),
    l2: capability('supported', 'WhiteBIT depth_subscribe provides bounded spot snapshots and update_id/past_update_id incremental updates', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason),
  }, 'src/adapters/whitebit.mts; AGGR reference: src/worker/exchanges/whitebit.ts'),
  entry('phemex', 'Phemex', 'supported', ['spot'], {
    products: capability('supported', 'public products metadata is available; product discovery remains configured-symbol scoped', ['spot']),
    trades: unsupportedPublic(),
    l2: capability('supported', 'Phemex full-depth orderbook provides provider-ordered spot snapshots and incremental updates with sequence tokens', ['spot'], ['native']),
    candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['spot']),
  }, 'src/adapters/phemex.mts; AGGR reference: src/worker/exchanges/phemex.ts'),
  entry('dydx', 'dYdX', 'supported', ['perpetual'], {
    products: capability('supported', 'public perpetualMarkets metadata is available; product discovery remains configured-symbol scoped', ['perpetual']),
    trades: capability('supported', 'public v4_trades stream provides perpetual executions; liquidation rows are excluded from ordinary trade delivery', ['perpetual']),
    l2: capability('supported', 'dYdX v4_orderbook provides an unbatched provider snapshot and connection-scoped sequenced price updates', ['perpetual'], ['native']), candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/dydx.mts; AGGR reference: src/worker/exchanges/dydx.ts'),
  entry('aster', 'Aster', 'supported', ['perpetual'], {
    products: capability('supported', 'public exchangeInfo metadata is available; product discovery remains configured-symbol scoped', ['perpetual']),
    trades: capability('supported', 'public aggTrade stream provides perpetual market executions', ['perpetual']),
    l2: capability('supported', 'Aster depth20@100ms provides partial top-20 snapshots; deeper liquidity is not represented', ['perpetual'], ['native']), candles: unsupportedPublic(), openInterest: unsupportedPublic(), executedLiquidations: unsupportedPublic(),
    futureLevels: capability('externallyBlocked', blockedReason, ['perpetual']),
  }, 'src/adapters/aster.mts; AGGR reference: src/worker/exchanges/aster.ts'),
]);

export type VenueCapabilitySnapshot = Omit<VenueCapability, 'marketTypes' | 'resolutions'> & {
  marketTypes?: MarketType[];
  resolutions?: BookResolution[];
};
export type VenueRegistrySnapshotEntry = Omit<VenueRegistryEntry, 'marketTypes' | 'capabilities'> & {
  marketTypes: MarketType[];
  capabilities: Record<VenueCapabilityKey, VenueCapabilitySnapshot>;
};

export function venueRegistrySnapshot(): VenueRegistrySnapshotEntry[] {
  return VENUE_REGISTRY.map((item) => ({ ...item, marketTypes: [...item.marketTypes], capabilities: Object.fromEntries(Object.entries(item.capabilities).map(([key, value]) => [key, { ...value, ...(value.marketTypes ? { marketTypes: [...value.marketTypes] } : {}), ...(value.resolutions ? { resolutions: [...value.resolutions] } : {}) }])) as Record<VenueCapabilityKey, VenueCapabilitySnapshot> }));
}

export function getVenue(venue: unknown) {
  return VENUE_REGISTRY.find((item) => item.venue === String(venue ?? '').toLowerCase()) ?? null;
}

export function getVenueCapability(venue: unknown, key: VenueCapabilityKey) {
  return getVenue(venue)?.capabilities?.[key] ?? (historyKeys.includes(key) ? historyCapability('unsupported', 'none', unsupportedReason) : capability('unsupported', unsupportedReason));
}
