export * from './common.mts';
export * from './hyperliquid.mts';
export * from './binance.mts';
export * from './bybit.mts';
export * from './bybit-depth-session.mts';
export * from './public-depth-session.mts';
export * from './venue-transport.mts';
export * from './okx.mts';
export * from './bitget.mts';
export * from './gateio.mts';
export * from './deribit.mts';
export * from './coinbase.mts';
export * from './kraken.mts';
export * from './kucoin.mts';
export * from './mexc.mts';
export * from './htx.mts';
export * from './bitfinex.mts';
export * from './bitmex.mts';
export * from './cryptocom.mts';
export * from './bitstamp.mts';
export * from './whitebit.mts';
export * from './phemex.mts';
export * from './dydx.mts';
export * from './aster.mts';
export * from './hypertracker.mts';

/** Concrete normalized adapter outputs, distinct from unknown transport payloads. */
export type AdapterDepthMessage =
  | ReturnType<typeof import('./hyperliquid.mts').normalizeHyperliquidBook>
  | ReturnType<typeof import('./binance.mts').normalizeBinanceDepth>
  | ReturnType<typeof import('./binance.mts').normalizeBinanceDepthDelta>
  | ReturnType<typeof import('./bybit.mts').normalizeBybitDepth>
  | ReturnType<typeof import('./bybit.mts').normalizeBybitDepthDelta>
  | ReturnType<typeof import('./okx.mts').normalizeOkxDepth>
  | ReturnType<typeof import('./bitget.mts').normalizeBitgetDepth>
  | ReturnType<typeof import('./gateio.mts').normalizeGateDepth>
  | ReturnType<typeof import('./deribit.mts').normalizeDeribitDepth>
  | ReturnType<typeof import('./coinbase.mts').normalizeCoinbaseDepth>
  | ReturnType<typeof import('./coinbase.mts').normalizeCoinbaseRestDepth>
  | ReturnType<typeof import('./kraken.mts').normalizeKrakenDepth>
  | ReturnType<typeof import('./kucoin.mts').normalizeKucoinDepth>
  | ReturnType<typeof import('./mexc.mts').normalizeMexcDepth>
  | ReturnType<typeof import('./htx.mts').normalizeHtxDepth>
  | ReturnType<typeof import('./bitfinex.mts').normalizeBitfinexDepth>
  | ReturnType<typeof import('./bitmex.mts').normalizeBitmexDepth>
  | ReturnType<typeof import('./cryptocom.mts').normalizeCryptocomDepth>
  | ReturnType<typeof import('./bitstamp.mts').normalizeBitstampDepth>
  | ReturnType<typeof import('./whitebit.mts').normalizeWhitebitDepth>
  | ReturnType<typeof import('./phemex.mts').normalizePhemexDepth>;
export type AdapterMetadataMessage =
  | ReturnType<typeof import('./hyperliquid.mts').normalizeHyperliquidMetadata>
  | ReturnType<typeof import('./binance.mts').normalizeBinanceExchangeInfo>
  | ReturnType<typeof import('./bybit.mts').normalizeBybitInstrumentInfo>
  | ReturnType<typeof import('./okx.mts').normalizeOkxInstrumentInfo>
  | ReturnType<typeof import('./bitget.mts').normalizeBitgetInstrumentInfo>
  | ReturnType<typeof import('./gateio.mts').normalizeGateContractInfo>
  | ReturnType<typeof import('./deribit.mts').normalizeDeribitInstrumentInfo>
  | ReturnType<typeof import('./coinbase.mts').normalizeCoinbaseProduct>
  | ReturnType<typeof import('./kraken.mts').normalizeKrakenAssetPairs>
  | ReturnType<typeof import('./kucoin.mts').normalizeKucoinSymbol>
  | ReturnType<typeof import('./mexc.mts').normalizeMexcContractInfo>
  | ReturnType<typeof import('./htx.mts').normalizeHtxContractInfo>
  | ReturnType<typeof import('./bitfinex.mts').normalizeBitfinexSymbolsDetails>
  | ReturnType<typeof import('./bitmex.mts').normalizeBitmexInstrument>
  | ReturnType<typeof import('./cryptocom.mts').normalizeCryptocomInstrument>
  | ReturnType<typeof import('./bitstamp.mts').normalizeBitstampTradingPairs>
  | ReturnType<typeof import('./whitebit.mts').normalizeWhitebitMarkets>
  | ReturnType<typeof import('./phemex.mts').normalizePhemexProducts>
  | ReturnType<typeof import('./dydx.mts').normalizeDydxMarkets>
  | ReturnType<typeof import('./aster.mts').normalizeAsterMarkets>;
export type AdapterTradeMessage =
  | ReturnType<typeof import('./hyperliquid.mts').normalizeHyperliquidTrade>
  | ReturnType<typeof import('./binance.mts').normalizeBinanceAggTrade>
  | ReturnType<typeof import('./dydx.mts').normalizeDydxTrade>
  | ReturnType<typeof import('./aster.mts').normalizeAsterTrade>;
export type AdapterOpenInterestMessage =
  | ReturnType<typeof import('./hyperliquid.mts').normalizeHyperliquidAssetContext>
  | ReturnType<typeof import('./binance.mts').normalizeBinanceOpenInterest>
  | ReturnType<typeof import('./bybit.mts').normalizeBybitOpenInterest>;
export type NormalizedAdapterMessage = AdapterDepthMessage | AdapterMetadataMessage | AdapterTradeMessage | AdapterOpenInterestMessage | (import('./common.mts').NormalizedAdapterCandle & { kind: 'candle' }) | ReturnType<typeof import('./hypertracker.mts').normalizeHyperTrackerSnapshot> | import('./common.mts').AdapterDepthBook;
export type AdapterTransportRequest = import('./common.mts').RequestDescriptor;
export type AdapterSubscriptionRequest = import('./common.mts').SubscriptionDescriptor;
