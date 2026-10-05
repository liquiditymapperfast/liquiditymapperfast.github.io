import type { PriceAmount, OpenInterestSample, HyperliquidMetadataSnapshot, TradeRecord } from '../domain/contracts.ts';
import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type NormalizedAdapterCandle, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, intervalMilliseconds, sideLevels, validateCandle } from './common.mts';
import { bookKey, bookResolutionKey } from '../core/book-key.mts';
import { hyperliquidGroupingBoundsDecimal } from '../analytics/hyperliquid-bounds.mts';

/** Hyperliquid public Info REST endpoint. No request is sent by this module. */
export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
export function hyperliquidCoin(symbol: unknown) {
  const value = String(symbol ?? '').trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new TypeError('Invalid exchange symbol');
  const withoutVenue = value.replace(/^hyperliquid:/i, '');
  const coin = withoutVenue.replace(/-PERP$/i, '');
  return coin.includes(':') ? coin : coin.toUpperCase();
}
export type HyperliquidOptions = AdapterOptions & { nativeCoin?: string };
/** Canonical IDs remain compatible; verified native API names preserve case. */
export function hyperliquidNativeCoin(coin: unknown, nativeCoin?: unknown): string {
  if (nativeCoin == null) return hyperliquidCoin(coin);
  if (typeof nativeCoin !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(nativeCoin)
    || /^hyperliquid:/i.test(nativeCoin) || /-PERP$/i.test(nativeCoin)) throw new TypeError('Invalid Hyperliquid native coin');
  if (hyperliquidCoin(nativeCoin) !== hyperliquidCoin(coin)) throw new TypeError('Hyperliquid native coin does not match canonical selected coin');
  return nativeCoin;
}
export function validateHyperliquidGrouping(nSigFigs: unknown, mantissa: unknown) {
  const sig = nSigFigs == null ? undefined : Number(nSigFigs);
  const mant = mantissa == null ? undefined : Number(mantissa);
  if (sig != null && (!Number.isInteger(sig) || sig < 2 || sig > 5)) throw new RangeError('Hyperliquid nSigFigs must be an integer from 2 to 5');
  if (mant != null && (!Number.isInteger(mant) || ![1, 2, 5].includes(mant))) throw new RangeError('Hyperliquid mantissa must be one of 1, 2, or 5');
  if (mant != null && sig !== 5) throw new RangeError('Hyperliquid mantissa is only valid when nSigFigs is 5');
  return { nSigFigs: sig, mantissa: mant };
}
/** Recover the per-price lower/upper edges used by Hyperliquid coarse books. */
export function hyperliquidBucketBounds(price: unknown, nSigFigs: unknown, mantissa?: unknown) {
  const px = finiteNumber(price, 'price');
  const grouping = validateHyperliquidGrouping(nSigFigs, mantissa);
  if (grouping.nSigFigs == null) return null;
  return hyperliquidGroupingBoundsDecimal(px, grouping.nSigFigs, grouping.mantissa);
}
export function hyperliquidBookResolutionKey({ nSigFigs = null, mantissa = null }: AdapterOptions = {}) {
  const grouping = validateHyperliquidGrouping(nSigFigs, mantissa);
  return bookResolutionKey({ resolution: grouping.nSigFigs == null && grouping.mantissa == null ? 'native' : 'coarse', ...grouping });
}
export function buildHyperliquidInfoRequest(type: string, params: HyperliquidOptions = {}) {
  const coin = recordValue(params).coin ? hyperliquidNativeCoin(recordValue(params).coin, params.nativeCoin) : undefined;
  let body;
  if (type === 'metaAndAssetCtxs' || type === 'allMids') body = { type };
  else if (type === 'l2Book') { const grouping = validateHyperliquidGrouping(recordValue(params).nSigFigs, recordValue(params).mantissa); body = { type, coin, ...(grouping.nSigFigs == null ? {} : { nSigFigs: grouping.nSigFigs }), ...(grouping.mantissa == null ? {} : { mantissa: grouping.mantissa }) }; }
  else if (type === 'candleSnapshot') body = { type, req: { coin, interval: String(recordValue(params).interval ?? '1h'), startTime: Math.trunc(finiteNumber(recordValue(params).startTime, 'startTime')), endTime: recordValue(params).endTime == null ? undefined : Math.trunc(finiteNumber(recordValue(params).endTime, 'endTime')) } };
  else throw new RangeError(`Unsupported Hyperliquid Info request: ${type}`);
  return { url: HYPERLIQUID_INFO_URL, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, (_key, value: unknown) => value === undefined ? undefined : value), ...(type === 'metaAndAssetCtxs' || type === 'allMids' ? { responseClass: 'catalog' } : {}) };
}
export function buildHyperliquidSubscription(type: string, params: HyperliquidOptions = {}) {
  const coin = hyperliquidNativeCoin(recordValue(params).coin, params.nativeCoin);
  const grouping = type === 'l2Book' ? validateHyperliquidGrouping(recordValue(params).nSigFigs, recordValue(params).mantissa) : { nSigFigs: undefined, mantissa: undefined };
  const subscription = type === 'l2Book' ? { type, coin, ...(grouping.nSigFigs == null ? {} : { nSigFigs: grouping.nSigFigs }), ...(grouping.mantissa == null ? {} : { mantissa: grouping.mantissa }) } : type === 'candle' ? { type, coin, interval: String(recordValue(params).interval ?? '1h') } : type === 'activeAssetCtx' ? { type, coin } : type === 'trades' ? { type, coin } : null;
  if (!subscription) throw new RangeError('Unsupported Hyperliquid subscription: ' + type);
  return { method: 'subscribe', subscription };
}


/** Match the documented echoed subscription; a pong proves only transport liveness. */
export function matchesHyperliquidSubscriptionResponse(payload: unknown, request: unknown): boolean {
  const frame = recordValue(payload);
  const reply = recordValue(frame.data);
  const expected = recordValue(recordValue(request).subscription);
  const actual = recordValue(reply.subscription);
  if (frame.channel !== 'subscriptionResponse' || reply.method !== 'subscribe') return false;
  if (typeof expected.type !== 'string' || actual.type !== expected.type) return false;
  if (!sameHyperliquidCoin(actual.coin, expected.coin)) return false;
  return ['interval', 'nSigFigs', 'mantissa', 'fast'].every(key => {
    // Current l2Book replies materialize omitted fast as false. This is the
    // documented slow/default snapshot, not permission to accept fast:true.
    const fallback = key === 'fast' && expected.type === 'l2Book' ? false : null;
    return (actual[key] ?? fallback) === (expected[key] ?? fallback);
  });
}

function sameHyperliquidCoin(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  try { hyperliquidNativeCoin(expected, expected); return actual === expected; }
  catch { return false; }
}

/** Check source identity before decoding so foreign frames cannot acknowledge or hydrate a feed. */
export function matchesHyperliquidSubscriptionData(payload: unknown, request: unknown): boolean {
  const frame = recordValue(payload);
  const expected = recordValue(recordValue(request).subscription);
  if (frame.channel !== expected.type || typeof expected.type !== 'string') return false;
  const data = frame.data;
  if (expected.type === 'trades') {
    return Array.isArray(data) && data.length > 0 && data.every(row => sameHyperliquidCoin(recordValue(row).coin, expected.coin));
  }
  if (expected.type === 'candle') {
    const rows = Array.isArray(data) ? data : [data];
    return rows.length > 0 && rows.every(row => {
      const candle = recordValue(row);
      return sameHyperliquidCoin(candle.s ?? candle.coin, expected.coin) && candle.i === expected.interval;
    });
  }
  return (expected.type === 'l2Book' || expected.type === 'activeAssetCtx') && sameHyperliquidCoin(recordValue(data).coin, expected.coin);
}

function payloadData(payload: unknown) { return recordValue(payload)?.data ?? payload; }
function sourceTimestampOrNull(value: unknown, { allowZero = false }: AdapterOptions = {}) {
  if (value == null) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) && (n > 0 || (allowZero && n === 0)) ? epochMs(n) : null;
}
function optionalNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function metadataParts(payload: unknown) {
  const data = payloadData(payload);
  if (Array.isArray(data)) return { meta: recordValue(data[0]), contexts: Array.isArray(data[1]) ? data[1] as unknown[] : [] };
  return { meta: recordValue(recordValue(data)?.meta ?? recordValue(data)?.metadata ?? data), contexts: recordValue(data)?.assetCtxs ?? recordValue(data)?.contexts ?? [] };
}
function contextFor(payload: unknown, coin: unknown) {
  const data = payloadData(payload);
  if (Array.isArray(data)) {
    const { meta, contexts } = metadataParts(payload);
    const wanted = hyperliquidCoin(coin);
    const universe = arrayValue(meta?.universe ?? []);
    const index = universe.findIndex((asset: unknown) => hyperliquidCoin(recordValue(asset)?.name ?? '') === wanted);
    if (index < 0) return { data: { coin: wanted }, context: undefined };
    return { data: { coin: recordValue(universe[index]).name }, context: recordValue(contexts)[String(index)] };
  }
  const context = recordValue(data)?.ctx ?? recordValue(data)?.context ?? data;
  return { data: { ...recordValue(data), context }, context };
}

/** Normalize the perpetual metadata response and keep optional fields explicit. */
export function normalizeHyperliquidMetadata(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}): HyperliquidMetadataSnapshot {
  const { meta, contexts } = metadataParts(payload);
  if (!Array.isArray(meta?.universe)) throw new TypeError('Hyperliquid metadata universe missing');
  const assets = meta.universe.map((asset: unknown, index: number) => {
    const name = String(recordValue(asset)?.name ?? '').trim();
    if (!name) throw new TypeError(`Hyperliquid metadata universe[${index}] name missing`);
    const context = recordValue(contexts)[String(index)];
    return {
      coin: name,
      instrumentId: `hyperliquid:${hyperliquidCoin(name)}-PERP`,
      szDecimals: recordValue(asset).szDecimals == null ? undefined : (Number.isInteger(Number(recordValue(asset).szDecimals)) ? Number(recordValue(asset).szDecimals) : undefined),
      maxLeverage: optionalNumber(recordValue(asset).maxLeverage),
      onlyIsolated: recordValue(asset).onlyIsolated === true,
      isDelisted: recordValue(asset).isDelisted === true,
      context: context && typeof context === 'object' ? {
        markPrice: optionalNumber(recordValue(context).markPx),
        oraclePrice: optionalNumber(recordValue(context).oraclePx),
        midPrice: optionalNumber(recordValue(context).midPx),
        funding: optionalNumber(recordValue(context).funding),
        openInterest: optionalNumber(recordValue(context).openInterest),
      } : undefined,
    };
  });
  return {
    kind: 'metadata' as const, venue: 'hyperliquid', sourceTimestamp: sourceTimestampOrNull(recordValue(payload)?.sourceTimestamp ?? recordValue(payload)?.time),
    receivedAt, assets,
  };
}

export interface HyperliquidPriceAmount extends PriceAmount { priceLow?: number; priceHigh?: number; sourceGrouping?: number; sourceGroupingBounds?: NonNullable<ReturnType<typeof hyperliquidBucketBounds>>; }
/** Normalize HL l2Book snapshots: levels[0] are bids and levels[1] asks, px/sz are base units. */
export function normalizeHyperliquidBook(payload: unknown, { instrumentId, nSigFigs, mantissa, resolutionKey, feedId, bookKey: explicitBookKey, receivedAt = Date.now() }: AdapterOptions = {}) {
  const data = payloadData(payload); const levels = recordValue(data)?.levels;
  if (!Array.isArray(levels) || levels.length < 2) throw new TypeError('Hyperliquid l2Book levels missing');
  const coin = hyperliquidCoin(recordValue(data).coin ?? instrumentId ?? 'BTC');
  const sourceTimestamp = sourceTimestampOrNull(recordValue(data).time);
  const responseSig = recordValue(data).nSigFigs == null ? undefined : Number(recordValue(data).nSigFigs);
  const responseMantissa = recordValue(data).mantissa == null ? undefined : Number(recordValue(data).mantissa);
  if (nSigFigs != null && responseSig != null && responseSig !== Number(nSigFigs)) throw new TypeError(`Hyperliquid l2Book response nSigFigs ${responseSig} contradicts requested ${nSigFigs}`);
  if (mantissa != null && responseMantissa != null && responseMantissa !== Number(mantissa)) throw new TypeError(`Hyperliquid l2Book response mantissa ${responseMantissa} contradicts requested ${mantissa}`);
  const resolutionDigits = responseSig ?? nSigFigs;
  const grouping = validateHyperliquidGrouping(resolutionDigits, responseMantissa ?? mantissa);
  const coarse = grouping.nSigFigs != null || grouping.mantissa != null;
  const annotate = (rows: PriceAmount[]): HyperliquidPriceAmount[] => coarse ? rows.map((row) => {
    // Coarse grouping validation above requires nSigFigs.
    const bounds = hyperliquidBucketBounds(row.price, grouping.nSigFigs, grouping.mantissa)!;
    return { ...row, priceLow: bounds.lower, priceHigh: bounds.upper, sourceGrouping: bounds.step, sourceGroupingBounds: bounds };
  }) : rows;
  const bids = annotate(sideLevels(levels[0], 'bids')); const asks = annotate(sideLevels(levels[1], 'asks'));
  const resolvedInstrumentId = instrumentId ?? ('hyperliquid:' + coin + '-PERP');
  const resolvedResolution = coarse ? 'coarse' : 'native';
  const observedResolutionKey = hyperliquidBookResolutionKey(grouping);
  if (resolutionKey != null && resolutionKey !== observedResolutionKey) throw new TypeError(`Hyperliquid l2Book response resolution ${observedResolutionKey} contradicts requested ${resolutionKey}`);
  const resolvedResolutionKey = resolutionKey ?? observedResolutionKey;
  return { kind: 'depthSnapshot' as const, instrumentId: resolvedInstrumentId, sourceTimestamp, receivedAt, sequence: sourceTimestamp == null ? undefined : Number(recordValue(data).time), complete: true, resolution: resolvedResolution, resolutionKey: resolvedResolutionKey, bookKey: explicitBookKey ?? bookKey(resolvedInstrumentId, resolvedResolutionKey), ...(feedId == null ? {} : { feedId }), coverage: 'partial' as const, ...(grouping.nSigFigs == null ? {} : { nSigFigs: grouping.nSigFigs }), ...(grouping.mantissa == null ? {} : { mantissa: grouping.mantissa }), bids, asks };
}
/** Normalize an asset context. openInterest is contracts/base units; quote is derived only when mark exists. */
export function normalizeHyperliquidAssetContext(payload: unknown, { coin = 'BTC', instrumentId, receivedAt = Date.now() }: AdapterOptions = {}) {
  const { data, context } = contextFor(payload, coin);
  const ctx = recordValue(context);
  const openInterest = finiteNumber(ctx?.openInterest, 'openInterest');
  const mark = ctx?.markPx == null ? undefined : finiteNumber(ctx.markPx, 'markPx');
  const sample: OpenInterestSample & { markPrice?: number } = { kind: 'openInterest' as const, instrumentId: instrumentId ?? `hyperliquid:${hyperliquidCoin(data?.coin ?? coin)}-PERP`, sourceTimestamp: sourceTimestampOrNull((recordValue(data) as WireRecord)?.time ?? recordValue(payload)?.time ?? ctx?.time), receivedAt, base: openInterest, quality: 'native' as const };
  if (mark !== undefined && mark > 0) { sample.quote = openInterest * mark; sample.markPrice = mark; }
  return sample;
}

function normalizedTradeSide(value: unknown): TradeRecord['side'] {
  const side = String(value ?? '').trim().toUpperCase();
  if (side === 'B' || side === 'BUY' || side === 'LONG') return 'buy';
  if (side === 'A' || side === 'S' || side === 'SELL' || side === 'SHORT') return 'sell';
  return 'unknown';
}

/** Normalize one Hyperliquid public trade. Trade ids remain deterministic across reconnects. */
export function normalizeHyperliquidTrade(row: unknown, { coin = 'BTC', receivedAt = Date.now() }: AdapterOptions = {}) {
  const value = recordValue(row)?.trade ?? row;
  const resolvedCoin = hyperliquidCoin(recordValue(value)?.coin ?? coin);
  const sourceTimestamp = sourceTimestampOrNull(recordValue(value)?.time ?? recordValue(value)?.timestamp);
  const price = finiteNumber(recordValue(value)?.px ?? recordValue(value)?.price, 'trade price');
  const amount = finiteNumber(recordValue(value)?.sz ?? recordValue(value)?.size ?? recordValue(value)?.amount, 'trade size');
  if (!(price > 0) || !(amount >= 0)) throw new TypeError('Invalid Hyperliquid trade values');
  const tid = recordValue(value)?.tid ?? recordValue(value)?.tradeId;
  const hash = recordValue(value)?.hash == null ? '' : String(recordValue(value).hash);
  const tradeId = tid != null && sourceTimestamp != null ? `${sourceTimestamp}:${resolvedCoin}:${String(tid)}` : hash || `${resolvedCoin}:${sourceTimestamp ?? receivedAt}:${price}:${amount}`;
  return {
    kind: 'trade' as const, venue: 'hyperliquid', instrumentId: `hyperliquid:${hyperliquidCoin(resolvedCoin)}-PERP`,
    tradeId, side: normalizedTradeSide(recordValue(value)?.side), price, amount, notionalUsd: price * amount,
    sourceTimestamp, receivedAt, hash: hash || undefined, tid: tid == null ? undefined : String(tid),
  };
}

/** Normalize both single-trade and websocket batch shapes. */
export function normalizeHyperliquidTrades(payload: unknown, { coin = 'BTC', receivedAt = Date.now() }: AdapterOptions = {}) {
  const data = payloadData(payload);
  const rows = Array.isArray(data) ? data : Array.isArray(recordValue(data)?.trades) ? recordValue(data).trades : recordValue(data)?.trade ? [recordValue(data).trade] : (recordValue(data)?.px != null || recordValue(data)?.price != null || recordValue(data)?.sz != null || recordValue(data)?.size != null) ? [data] : [];
  return arrayValue(rows).map((row: unknown) => normalizeHyperliquidTrade(row, { coin, receivedAt }));
}
export function normalizeHyperliquidCandle(row: unknown, { coin = 'BTC', interval = '1h', receivedAt = Date.now() }: AdapterOptions = {}): NormalizedAdapterCandle {
  const values = Array.isArray(row) ? { start:row[0], end:row[1], open:row[2], high:row[3], low:row[4], close:row[5], volume:row[6] } : recordValue(row)?.candle ?? row;
  const normalized = { start: recordValue(values)?.start ?? recordValue(values)?.t, end: recordValue(values)?.end ?? recordValue(values)?.T, open: recordValue(values)?.open ?? recordValue(values)?.o, high: recordValue(values)?.high ?? recordValue(values)?.h, low: recordValue(values)?.low ?? recordValue(values)?.l, close: recordValue(values)?.close ?? recordValue(values)?.c, volume: recordValue(values)?.volume ?? recordValue(values)?.v };
  const start = sourceTimestampOrNull(normalized.start, { allowZero: true }) ?? Number.NaN;
  const rawEnd = normalized.end == null ? null : sourceTimestampOrNull(normalized.end);
  if (normalized.end != null && rawEnd == null) throw new TypeError('Invalid Hyperliquid candle end timestamp');
  const duration = intervalMilliseconds(interval);
  const end = rawEnd ?? (Number.isFinite(start) && duration ? start + duration : Number.NaN);
  const candle = { instrumentId:`hyperliquid:${hyperliquidCoin(coin)}-PERP`, interval, start, end, open:finiteNumber(normalized.open,'open'), high:finiteNumber(normalized.high,'high'), low:finiteNumber(normalized.low,'low'), close:finiteNumber(normalized.close,'close'), volume:finiteNumber(normalized.volume ?? 0,'volume'), sourceTimestamp:rawEnd };
  validateCandle(candle);
  const closed = recordValue(values)?.closed ?? recordValue(values)?.x;
  return closed == null ? candle : { ...candle, closed: Boolean(closed) };
}
/** Connector boundary. It is inert by default; injected transports and allowNetwork are required for I/O. */
export class HyperliquidConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async info(type: string, params: HyperliquidOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Hyperliquid network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildHyperliquidInfoRequest(type, params)); }
  async subscribe(type: string, params: HyperliquidOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Hyperliquid network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildHyperliquidSubscription(type, params)); }
}
