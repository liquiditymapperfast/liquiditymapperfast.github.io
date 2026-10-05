import type { OpenInterestSample } from '../domain/contracts.ts';
import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type NormalizedAdapterCandle, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, intervalMilliseconds, requireSymbol, sideLevels, validateCandle } from './common.mts';

/** Binance public market-data hosts. Adapters only build descriptors; they do not fetch. */
export const BINANCE_SPOT_REST_URL = 'https://api.binance.com';
export const BINANCE_FUTURES_REST_URL = 'https://fapi.binance.com';
export const BINANCE_SPOT_WS_URL = 'wss://stream.binance.com:9443/ws';
export const BINANCE_FUTURES_WS_URL = 'wss://fstream.binance.com/public/ws';
export const BINANCE_FUTURES_MARKET_WS_URL = 'wss://fstream.binance.com/market/ws';
export const BINANCE_COIN_FUTURES_REST_URL = 'https://dapi.binance.com';
export const BINANCE_COIN_FUTURES_WS_URL = 'wss://dstream.binance.com/ws';
export type BinanceFamily = 'usdm' | 'coinm';
export function binanceFamily(family: unknown = 'usdm', marketType: unknown = 'perpetual'): BinanceFamily {
  if (family !== 'usdm' && family !== 'coinm') throw new RangeError('Unsupported Binance futures family');
  if (family === 'coinm' && marketType === 'spot') throw new RangeError('Binance COIN-M cannot be configured as spot');
  return family;
}
function marketBase(marketType: unknown, family: BinanceFamily) { return marketType === 'spot' ? BINANCE_SPOT_REST_URL : family === 'coinm' ? BINANCE_COIN_FUTURES_REST_URL : BINANCE_FUTURES_REST_URL; }
function positiveWireNumber(value: unknown, field: string): number {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new TypeError('Invalid Binance ' + field);
  return Number(value);
}
function coinMetadata(symbol: unknown, metadata: unknown): WireRecord & { contractValue: number; pair: string; exchangeContractType: string } {
  const native = requireSymbol(symbol), meta = recordValue(metadata);
  if (meta.nativeSymbol !== native || meta.instrumentId !== binanceInstrumentId(native, meta.marketType, 'coinm')
    || meta.family !== 'coinm' || meta.quantityUnit !== 'contract' || meta.inverse !== true || meta.contractType !== 'inverse'
    || meta.quote !== 'USD' || typeof meta.base !== 'string' || !meta.base || meta.settleCoin !== meta.base
    || meta.status !== 'TRADING' || meta.isDelisted !== false || typeof meta.pair !== 'string' || !meta.pair
    || !['PERPETUAL', 'CURRENT_QUARTER', 'NEXT_QUARTER'].includes(String(meta.exchangeContractType))) {
    throw new TypeError('Binance COIN-M requires matching active verified inverse contract metadata');
  }
  return { ...meta, contractValue: positiveWireNumber(meta.contractValue, 'COIN-M contract value'), pair: meta.pair, exchangeContractType: String(meta.exchangeContractType) };
}
function nonnegativeCoinAmount(value: unknown, field: string): number {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) || !Number.isFinite(Number(value)) || Number(value) < 0) throw new TypeError('Invalid Binance ' + field);
  return Number(value);
}
function familyLevels(values: unknown, field: string, family: BinanceFamily) {
  if (family !== 'coinm') return sideLevels(values, field);
  if (!Array.isArray(values)) throw new TypeError('Binance COIN-M ' + field + ' must be an array');
  return values.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new TypeError('Binance COIN-M depth row is malformed');
    return { price: positiveWireNumber(row[0], field + '[' + index + '].price'), amount: nonnegativeCoinAmount(row[1], field + '[' + index + '].amount') };
  });
}
function depthUnits(symbol: unknown, family: BinanceFamily, metadata: unknown) {
  if (family !== 'coinm') return {};
  const meta = coinMetadata(symbol, metadata);
  return { units: 'contract' as const, contractValue: meta.contractValue, inverse: true, contractType: 'inverse' };
}
function endpointPath(marketType: unknown, kind: string, family: BinanceFamily) {
  if (family === 'coinm') {
    if (kind === 'openInterestHistory') return '/futures/data/openInterestHist';
    const endpoints: Readonly<Record<string, string>> = { depth: 'depth', klines: 'klines', exchangeInfo: 'exchangeInfo', openInterest: 'openInterest' };
    if (!endpoints[kind]) throw new RangeError(`Unsupported Binance COIN-M request: ${kind}`);
    return '/dapi/v1/' + endpoints[kind];
  }
  if (kind === 'depth') return marketType === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';
  if (kind === 'klines') return marketType === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
  if (kind === 'exchangeInfo') return marketType === 'spot' ? '/api/v3/exchangeInfo' : '/fapi/v1/exchangeInfo';
  if (kind === 'openInterest') { if (marketType === 'spot') throw new RangeError('Binance spot markets do not expose open interest'); return '/fapi/v1/openInterest'; }
  if (kind === 'openInterestHistory') { if (marketType === 'spot') throw new RangeError('Binance spot markets do not expose open interest'); return '/futures/data/openInterestHist'; }
  throw new RangeError(`Unsupported Binance request: ${kind}`);
}
export function binanceInstrumentId(symbol: unknown, marketType: unknown = 'perpetual', family: unknown = 'usdm') { binanceFamily(family, marketType); const value = requireSymbol(symbol); return `binance:${value}${marketType === 'spot' ? ':spot' : ''}`; }
export function isBinanceUsdtTradeSymbol(symbol: unknown) { const value = requireSymbol(symbol); return value.length > 4 && value.endsWith('USDT'); }
export function buildBinanceRequest(kind: string, { symbol, marketType = 'perpetual', family = 'usdm', metadata, limit, interval, period, startTime, endTime, baseUrl }: AdapterOptions = {}) {
  const type = marketType === 'spot' ? 'spot' : 'perpetual', selectedFamily = binanceFamily(family, type); const query = new URLSearchParams();
  if (selectedFamily === 'coinm' && kind === 'openInterestHistory') {
    const meta = coinMetadata(symbol, metadata);
    query.set('pair', meta.pair); query.set('contractType', meta.exchangeContractType);
  } else if (symbol != null || kind !== 'exchangeInfo') query.set('symbol', requireSymbol(symbol));
  if (limit != null) query.set('limit', String(Math.trunc(finiteNumber(limit,'limit'))));
  if (interval != null) query.set('interval', String(interval));
  if (period != null) query.set('period', String(period));
  if (startTime != null) query.set('startTime', String(Math.trunc(finiteNumber(startTime,'startTime'))));
  if (endTime != null) query.set('endTime', String(Math.trunc(finiteNumber(endTime,'endTime'))));
  return { url:`${baseUrl ?? marketBase(type, selectedFamily)}${endpointPath(type,kind,selectedFamily)}?${query}`, method:'GET', headers:{accept:'application/json'}, ...(kind === 'exchangeInfo' ? { responseClass: 'catalog' } : {}) };
}
export function buildBinanceSubscription(kind: string, { symbol, marketType = 'perpetual', family = 'usdm', interval = '1h' }: AdapterOptions = {}) {
  const type = marketType === 'spot' ? 'spot' : 'perpetual', selectedFamily = binanceFamily(family, type); const lower = requireSymbol(symbol).toLowerCase(); const stream = kind === 'depth' ? `${lower}@depth@100ms` : kind === 'kline' ? `${lower}@kline_${interval}` : kind === 'markPrice' ? (type === 'spot' ? `${lower}@trade` : `${lower}@markPrice@1s`) : kind === 'aggTrade' ? `${lower}@aggTrade` : null;
  if (!stream) throw new RangeError(`Unsupported Binance subscription: ${kind}`);
  const base = type === 'spot' ? BINANCE_SPOT_WS_URL : selectedFamily === 'coinm' ? BINANCE_COIN_FUTURES_WS_URL : kind === 'depth' ? BINANCE_FUTURES_WS_URL : BINANCE_FUTURES_MARKET_WS_URL;
  return { url:`${base}/${stream}`, stream };
}
function dataOf(payload: unknown) { return recordValue(payload)?.data ?? payload; }
function binanceDepthUpdateId(value: unknown, field: string, { allowZero = false }: AdapterOptions = {}) {
  const isNumber = typeof value === 'number' && Number.isSafeInteger(value);
  const isString = typeof value === 'string' && /^\d+$/.test(value);
  const parsed = Number(value);
  if ((!isNumber && !isString) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new TypeError(`Binance depth ${field} missing or invalid`);
  }
  return parsed;
}
export function normalizeBinanceDepth(payload: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  const data = dataOf(payload); const sourceTimestamp = epochMs(recordValue(data).E ?? recordValue(data).T ?? recordValue(data).time, receivedAt);
  if (!Array.isArray(recordValue(data).bids) || !Array.isArray(recordValue(data).asks)) throw new TypeError('Binance depth bids/asks missing');
  const native = symbol ?? recordValue(data).s ?? 'BTCUSDT', selectedFamily = binanceFamily(family, marketType);
  const id = binanceInstrumentId(native, marketType, selectedFamily);
  if (selectedFamily === 'coinm' && String(recordValue(data).symbol ?? recordValue(data).s ?? native).toUpperCase() !== requireSymbol(native)) throw new TypeError('Binance COIN-M depth symbol mismatch');
  const sequence = binanceDepthUpdateId(recordValue(data).lastUpdateId ?? recordValue(data).u, 'snapshot update ID');
  return { kind: 'depthSnapshot' as const, instrumentId:id, sourceTimestamp, receivedAt, sequence, complete:true, coverage: 'partial' as const, bids:familyLevels(recordValue(data).bids,'bids',selectedFamily), asks:familyLevels(recordValue(data).asks,'asks',selectedFamily), marketType, ...depthUnits(native, selectedFamily, metadata) };
}
export function normalizeBinanceDepthDelta(payload: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  const data = dataOf(payload); if (family === 'coinm' && String(recordValue(data).s ?? '').toUpperCase() !== requireSymbol(symbol ?? recordValue(data).s)) throw new TypeError('Binance COIN-M depth delta symbol mismatch'); if (!Array.isArray(recordValue(data).b) || !Array.isArray(recordValue(data).a)) throw new TypeError('Binance depth delta b/a missing');
  const firstUpdate = binanceDepthUpdateId(recordValue(data).U, 'first update ID');
  const sequence = binanceDepthUpdateId(recordValue(data).u, 'final update ID');
  if (firstUpdate > sequence) throw new TypeError('Binance depth update range is invalid');
  // Spot has U/u update ranges and no pu. USD-M's pu is the previous event's
  // final update ID; deriving it from U would hide a missing continuity token.
  const previousSequence = marketType === 'spot'
    ? firstUpdate - 1
    : binanceDepthUpdateId(recordValue(data).pu, 'previous update ID', { allowZero: true });
  if (marketType !== 'spot' && previousSequence >= sequence) throw new TypeError('Binance depth previous update ID is invalid');
  return { kind: 'depthDelta' as const, instrumentId:binanceInstrumentId(symbol ?? recordValue(data).s ?? 'BTCUSDT', marketType, family), ...depthUnits(symbol ?? recordValue(data).s, binanceFamily(family, marketType), metadata), sourceTimestamp:epochMs(recordValue(data).E ?? recordValue(data).T,receivedAt), receivedAt, firstUpdate, sequence, previousSequence, bids:familyLevels(recordValue(data).b,'bids',binanceFamily(family,marketType)), asks:familyLevels(recordValue(data).a,'asks',binanceFamily(family,marketType)), marketType };
}
/** One public aggregate execution for the configured USD-quoted market. */
export function normalizeBinanceAggTrade(payload: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  const hasStream = payload != null && Object.prototype.hasOwnProperty.call(payload, 'stream');
  const hasData = payload != null && Object.prototype.hasOwnProperty.call(payload, 'data');
  if (hasStream !== hasData) throw new TypeError('Binance aggregate trade raw/combined frame mismatch');
  if (hasStream && (recordValue(payload).data == null || typeof recordValue(payload).data !== 'object' || Array.isArray(recordValue(payload).data))) throw new TypeError('Binance aggregate trade combined data missing');
  const data = dataOf(payload);
  if (recordValue(data)?.e !== 'aggTrade') throw new TypeError('Binance aggregate trade event missing');
  const expectedSymbol = requireSymbol(symbol ?? recordValue(data)?.s);
  const selectedFamily = binanceFamily(family, marketType), inverseMeta = selectedFamily === 'coinm' ? coinMetadata(expectedSymbol, metadata) : null;
  if (!inverseMeta && !isBinanceUsdtTradeSymbol(expectedSymbol)) throw new RangeError('Binance aggregate trade USD equivalent requires a USDT-quoted symbol');
  if (hasStream && String(recordValue(payload).stream).toLowerCase() !== buildBinanceSubscription('aggTrade', { symbol: expectedSymbol, marketType, family }).stream.toLowerCase()) throw new TypeError('Binance aggregate trade stream mismatch');
  if (String(recordValue(data)?.s ?? '').toUpperCase() !== expectedSymbol) throw new TypeError('Binance aggregate trade symbol mismatch');
  const rawId = recordValue(data)?.a;
  const id = Number(rawId);
  if ((typeof rawId !== 'number' && (typeof rawId !== 'string' || !/^\d+$/.test(rawId)))
    || !Number.isSafeInteger(id) || id < 0) throw new TypeError('Binance aggregate trade id missing or invalid');
  const rawTime = recordValue(data)?.T;
  const sourceTimestamp = Number(rawTime);
  if ((typeof rawTime !== 'number' && (typeof rawTime !== 'string' || !/^\d+$/.test(rawTime)))
    || !Number.isSafeInteger(sourceTimestamp) || sourceTimestamp <= 0) throw new TypeError('Binance aggregate trade time missing or invalid');
  for (const [name, value] of [['price', recordValue(data)?.p], ['quantity', recordValue(data)?.q]]) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) throw new TypeError(`Binance aggregate trade ${name} wire type invalid`);
  }
  const price = finiteNumber(recordValue(data)?.p, 'Binance aggregate trade price');
  const amount = finiteNumber(recordValue(data)?.q, 'Binance aggregate trade quantity');
  const notionalUsd = inverseMeta ? amount * inverseMeta.contractValue : price * amount;
  const baseAmount = inverseMeta ? notionalUsd / price : amount;
  if (!Number.isFinite(baseAmount)) throw new TypeError('Binance aggregate trade base conversion overflows');
  if (!(price > 0) || !(amount > 0) || !Number.isFinite(notionalUsd)) throw new TypeError('Binance aggregate trade values invalid');
  if (typeof recordValue(data)?.m !== 'boolean') throw new TypeError('Binance aggregate trade maker flag missing or invalid');
  return { kind: 'trade' as const, venue: 'binance', instrumentId: binanceInstrumentId(expectedSymbol, marketType, family),
    tradeId: `${expectedSymbol}:${id}`, side: recordValue(data).m ? 'sell' : 'buy', price, amount: baseAmount, notionalUsd, ...(inverseMeta ? { nativeAmount: amount, units: 'contract', contractValue: inverseMeta.contractValue, inverse: true } : {}),
    sourceTimestamp, receivedAt, marketType };
}
/** Normalize the selected row from Binance's public exchangeInfo contract. */
export function normalizeBinanceExchangeInfo(payload: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  const rows = recordValue(dataOf(payload))?.symbols;
  if (!Array.isArray(rows)) throw new TypeError('Binance exchangeInfo symbols missing');
  const expected = symbol == null ? null : requireSymbol(symbol);
  const selected = expected == null ? rows : rows.filter((row: unknown) => String(recordValue(row)?.symbol ?? '').toUpperCase() === expected);
  if (expected != null && selected.length === 0) return { kind: 'metadata' as const, venue: 'binance', sourceTimestamp: epochMs(recordValue(dataOf(payload))?.serverTime, receivedAt), receivedAt, assets: [] };
  const selectedFamily = binanceFamily(family, marketType);
  const assets = selected.map((row: unknown, index) => {
    const nativeSymbol = requireSymbol(recordValue(row)?.symbol);
    const priceFilter = Array.isArray(recordValue(row)?.filters) ? arrayValue(recordValue(row).filters).find((filter: unknown) => recordValue(filter)?.filterType === 'PRICE_FILTER') : null;
    const lotFilter = Array.isArray(recordValue(row)?.filters) ? arrayValue(recordValue(row).filters).find((filter: unknown) => recordValue(filter)?.filterType === 'LOT_SIZE' || recordValue(filter)?.filterType === 'MARKET_LOT_SIZE') : null;
    const tickSize = recordValue(priceFilter)?.tickSize == null ? null : selectedFamily === 'coinm' ? positiveWireNumber(recordValue(priceFilter).tickSize, 'COIN-M tickSize') : finiteNumber(recordValue(priceFilter).tickSize, `symbols[${index}].tickSize`);
    const qtyStep = recordValue(lotFilter)?.stepSize == null ? null : selectedFamily === 'coinm' ? positiveWireNumber(recordValue(lotFilter).stepSize, 'COIN-M lotSize') : finiteNumber(recordValue(lotFilter).stepSize, `symbols[${index}].stepSize`);
    if (tickSize == null || !(tickSize > 0)) throw new TypeError(`Invalid symbols[${index}].tickSize`);
    if (qtyStep == null || !(qtyStep > 0)) throw new TypeError(`Invalid symbols[${index}].stepSize`);
    const status = String(recordValue(row)?.status ?? recordValue(row)?.contractStatus ?? '').toUpperCase();
    const base = String(recordValue(row)?.baseAsset ?? '').toUpperCase();
    const quote = String(recordValue(row)?.quoteAsset ?? recordValue(row)?.quoteCoin ?? '').toUpperCase();
    if (!base || !quote) throw new TypeError(`Invalid symbols[${index}] Binance base/quote metadata`);
    const exchangeContractType = String(recordValue(row).contractType ?? '');
    const settleCoin = String(recordValue(row).marginAsset ?? '').toUpperCase();
    const contractValue = selectedFamily === 'coinm' ? positiveWireNumber(recordValue(row).contractSize, 'COIN-M contractSize') : null;
    if (selectedFamily === 'coinm' && (typeof recordValue(row).baseAsset !== 'string' || typeof recordValue(row).quoteAsset !== 'string' || typeof recordValue(row).marginAsset !== 'string' || quote !== 'USD' || settleCoin !== base || !['PERPETUAL','CURRENT_QUARTER','NEXT_QUARTER'].includes(exchangeContractType))) throw new TypeError('Binance COIN-M metadata family/settlement mismatch');
    const assetMarketType = selectedFamily === 'coinm' && exchangeContractType !== 'PERPETUAL' ? 'delivery' : marketType;
    return {
      instrumentId: binanceInstrumentId(nativeSymbol, assetMarketType, family), venue: 'binance', symbol: nativeSymbol,
      nativeSymbol, base, quote, marketType: assetMarketType, contractType: selectedFamily === 'coinm' ? 'inverse' : recordValue(row)?.contractType ?? null, ...(selectedFamily === 'coinm' ? { family: 'coinm', inverse: true, contractValue, exchangeContractType, pair: requireSymbol(recordValue(row).pair) } : {}),
      ...(recordValue(row)?.marginAsset == null ? {} : { settleCoin: String(recordValue(row).marginAsset).toUpperCase() }),
      tickSize, qtyStep, lotSize: qtyStep,
      quantityUnit: selectedFamily === 'coinm' ? 'contract' : 'base', status: status || null, isDelisted: status !== 'TRADING',
    };
  });
  return { kind: 'metadata' as const, venue: 'binance', sourceTimestamp: epochMs(recordValue(dataOf(payload))?.serverTime, receivedAt), receivedAt, assets };
}
export function normalizeBinanceOpenInterest(payload: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, receivedAt = Date.now(), markPrice }: AdapterOptions = {}) {
  if (marketType === 'spot') throw new RangeError('Binance spot markets do not expose open interest');
  const data = dataOf(payload);
  const selectedFamily = binanceFamily(family, marketType), native = symbol ?? recordValue(data).symbol ?? recordValue(data).s ?? 'BTCUSDT';
  const meta = selectedFamily === 'coinm' ? coinMetadata(native, metadata) : null;
  const raw = meta ? nonnegativeCoinAmount(recordValue(data).openInterest, 'COIN-M openInterest') : finiteNumber(recordValue(data).openInterest, 'openInterest');
  if (raw < 0) throw new TypeError('Binance openInterest cannot be negative');
  const quote = meta ? raw * meta.contractValue : null;
  if (quote != null && !Number.isFinite(quote)) throw new TypeError('Binance COIN-M OI conversion overflows');
  const basis = meta ? positiveWireNumber(markPrice, 'COIN-M OI price basis') : null;
  if (meta && String(recordValue(data).symbol ?? recordValue(data).s ?? '').toUpperCase() !== requireSymbol(native)) throw new TypeError('Binance COIN-M OI symbol mismatch');
  const base = meta && basis && quote != null ? quote / basis : raw;
  if (!Number.isFinite(base)) throw new TypeError('Binance COIN-M OI base conversion overflows');
  const sample: OpenInterestSample = { kind: 'openInterest' as const, instrumentId:binanceInstrumentId(symbol ?? recordValue(data).symbol ?? recordValue(data).s ?? 'BTCUSDT', marketType, family), sourceTimestamp:epochMs(recordValue(data).time,receivedAt), receivedAt, base, quality: 'native' as const };
  const mark = markPrice == null ? undefined : finiteNumber(markPrice,'markPrice'); if (meta && quote != null) sample.quote = quote; else if (mark !== undefined && mark > 0) sample.quote = base * mark; return sample;
}
/** Normalize Binance's public open-interest statistics history.  These are
 * interval samples; downstream OHLC uses the sample as open=high=low=close
 * rather than inventing intraperiod extrema. */
export function normalizeBinanceOpenInterestHistory(payload: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  if (marketType === 'spot') throw new RangeError('Binance spot markets do not expose open interest');
  const rows = dataOf(payload);
  if (!Array.isArray(rows)) throw new TypeError('Binance open-interest history must be an array');
  const selectedFamily = binanceFamily(family, marketType);
  const instrumentId = binanceInstrumentId(symbol ?? rows[0]?.symbol ?? 'BTCUSDT', marketType, selectedFamily);
  const inverseMeta = selectedFamily === 'coinm' ? coinMetadata(symbol, metadata) : null;
  return rows.map((row: unknown) => {
    const timestamp = epochMs(recordValue(row)?.timestamp ?? recordValue(row)?.time, Number.NaN);
    const contracts = inverseMeta ? nonnegativeCoinAmount(recordValue(row).sumOpenInterest, 'COIN-M sumOpenInterest') : finiteNumber(recordValue(row)?.sumOpenInterest ?? recordValue(row)?.openInterest, 'sumOpenInterest');
    if (contracts < 0) throw new TypeError('Binance OI history cannot be negative');
    if (inverseMeta && (recordValue(row).pair !== inverseMeta.pair || recordValue(row).contractType !== inverseMeta.exchangeContractType)) throw new TypeError('Binance COIN-M OI history family mismatch');
    const quoteRaw = recordValue(row)?.sumOpenInterestValue ?? recordValue(row)?.openInterestValue;
    const nativeValue = quoteRaw == null ? undefined : inverseMeta ? nonnegativeCoinAmount(quoteRaw, 'COIN-M sumOpenInterestValue') : finiteNumber(quoteRaw, 'sumOpenInterestValue');
    if (nativeValue != null && nativeValue < 0) throw new TypeError('Binance OI value cannot be negative');
    if (inverseMeta && nativeValue == null) throw new TypeError('Binance COIN-M OI history requires observed base asset value');
    const base = inverseMeta ? nativeValue! : contracts;
    const quote = inverseMeta ? contracts * inverseMeta.contractValue : nativeValue;
    if (quote != null && !Number.isFinite(quote)) throw new TypeError('Binance COIN-M OI history conversion overflows');
    if (!(timestamp > 0)) throw new TypeError('Binance open-interest history timestamp missing');
    return { kind: 'openInterest' as const, instrumentId, sourceTimestamp:timestamp, observationTimestamp:timestamp, receivedAt, base, ...(quote == null ? {} : { quote }), quality: 'sampled' as const, source:'binance-openInterestHist', historySource:'binance-public-statistics' };
  }).sort((a, b) => a.sourceTimestamp - b.sourceTimestamp);
}
function explicitCandleTime(value: unknown, { allowZero = false }: AdapterOptions = {}) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && (numeric > 0 || (allowZero && numeric === 0)) ? epochMs(numeric) : null;
}
export function normalizeBinanceKline(row: unknown, { symbol, marketType = 'perpetual', family = 'usdm', metadata, interval = '1h', receivedAt = Date.now() }: AdapterOptions = {}): NormalizedAdapterCandle {
  const v = Array.isArray(row) ? {start:row[0],open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],baseVolume:row[7],end:row[6]} : recordValue(row)?.kline ?? row;
  const selectedFamily = binanceFamily(family, marketType);
  if (selectedFamily === 'coinm') {
    const meta = coinMetadata(symbol ?? recordValue(v).s, metadata);
    if (recordValue(v).s != null && recordValue(v).s !== meta.nativeSymbol) throw new TypeError('Binance COIN-M candle symbol mismatch');
  }
  const normalized = { start: recordValue(v)?.start ?? recordValue(v)?.t, open: recordValue(v)?.open ?? recordValue(v)?.o, high: recordValue(v)?.high ?? recordValue(v)?.h, low: recordValue(v)?.low ?? recordValue(v)?.l, close: recordValue(v)?.close ?? recordValue(v)?.c, volume: selectedFamily === 'coinm' ? recordValue(v).baseVolume ?? recordValue(v).q : recordValue(v)?.volume ?? recordValue(v)?.v, end: recordValue(v)?.end ?? recordValue(v)?.T };
  const start = explicitCandleTime(normalized.start, { allowZero: true }) ?? Number.NaN;
  const rawEnd = normalized.end == null ? null : explicitCandleTime(normalized.end);
  if (normalized.end != null && rawEnd == null) throw new TypeError('Invalid Binance kline end timestamp');
  const duration = intervalMilliseconds(interval);
  const end = rawEnd ?? (Number.isFinite(start) && duration ? start + duration : Number.NaN);
  const candle = { instrumentId:binanceInstrumentId(symbol ?? recordValue(v)?.symbol ?? recordValue(v)?.s ?? 'BTCUSDT', marketType, family), marketType, interval, start, end, open:finiteNumber(normalized.open,'open'), high:finiteNumber(normalized.high,'high'), low:finiteNumber(normalized.low,'low'), close:finiteNumber(normalized.close,'close'), volume:selectedFamily === 'coinm' ? nonnegativeCoinAmount(normalized.volume,'COIN-M base volume') : finiteNumber(normalized.volume ?? 0,'volume'), sourceTimestamp:rawEnd };
  validateCandle(candle);
  const closed = recordValue(v)?.closed ?? recordValue(v)?.x;
  return closed == null ? candle : { ...candle, closed: Boolean(closed) };
}
/** Connector boundary. Default construction cannot contact Binance. */
export class BinanceConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Binance network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildBinanceRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Binance network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildBinanceSubscription(kind, params)); }
}
