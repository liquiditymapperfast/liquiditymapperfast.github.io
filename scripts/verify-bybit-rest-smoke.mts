import { smokeRecord, smokeArray } from './smoke-boundaries.mts';
import type { AdapterOptions } from '../src/adapters/common.mts';
import {
  buildBybitRequest,
  normalizeBybitDepth,
  normalizeBybitInstrumentInfo,
  normalizeBybitKline,
  normalizeBybitOpenInterest,
} from '../src/adapters/bybit.mts';

type BybitRestKind = 'instruments' | 'depth' | 'klines' | 'openInterest';
interface RestResponseSummary { http: number; retCode: unknown }
interface InstrumentSummary extends RestResponseSummary {
  category: unknown; rows: number; instrumentId?: string; marketType?: string;
  tickSize?: number; qtyStep?: number; quantityUnit?: string;
}
type DepthSummary = RestResponseSummary & Pick<ReturnType<typeof normalizeBybitDepth>, 'instrumentId' | 'sequence' | 'coverage' | 'sourceTimestamp'> & { bids: number; asks: number };
interface CandleSummary extends RestResponseSummary {
  rows: number;
  first?: Pick<ReturnType<typeof normalizeBybitKline>, 'start' | 'open' | 'high' | 'low' | 'close' | 'volume'>;
}
type OpenInterestSummary = RestResponseSummary & Pick<ReturnType<typeof normalizeBybitOpenInterest>, 'instrumentId' | 'base' | 'quote' | 'sourceTimestamp' | 'quality'>;
interface BybitRestSmokeResults {
  instruments?: InstrumentSummary;
  depth?: DepthSummary;
  klines?: CandleSummary;
  openInterest?: OpenInterestSummary;
}
const receivedAt = Date.now();
const requests: [BybitRestKind, AdapterOptions][] = [
  ['instruments', { category: 'linear', symbol: 'BTCUSDT', limit: 1 }],
  ['depth', { category: 'linear', symbol: 'BTCUSDT', limit: 50 }],
  ['klines', { category: 'linear', symbol: 'BTCUSDT', interval: '1h', limit: 2 }],
  ['openInterest', { category: 'linear', symbol: 'BTCUSDT', intervalTime: '5min', limit: 2 }],
];

const fetched = await Promise.all(requests.map(async ([kind, params]) => {
  const request = buildBybitRequest(kind, params);
  const response = await fetch(request.url);
  const payload: unknown = await response.json();
  return { kind, response, payload };
}));

const results: BybitRestSmokeResults = {};
for (const { kind, response, payload } of fetched) {
  if (kind === 'instruments') {
    const normalized = normalizeBybitInstrumentInfo(payload, { receivedAt });
    const asset = normalized.assets[0];
    results.instruments = {
      http: response.status,
      retCode: smokeRecord(payload).retCode,
      category: smokeRecord(smokeRecord(payload).result).category,
      rows: normalized.assets.length,
      instrumentId: asset?.instrumentId,
      marketType: asset?.marketType,
      tickSize: asset?.tickSize,
      qtyStep: asset?.qtyStep,
      quantityUnit: asset?.quantityUnit,
    };
  } else if (kind === 'depth') {
    const normalized = normalizeBybitDepth(payload, { receivedAt });
    results.depth = {
      http: response.status,
      retCode: smokeRecord(payload).retCode,
      instrumentId: normalized.instrumentId,
      sequence: normalized.sequence,
      bids: normalized.bids.length,
      asks: normalized.asks.length,
      coverage: normalized.coverage,
      sourceTimestamp: normalized.sourceTimestamp,
    };
  } else if (kind === 'klines') {
    const candles = smokeArray(smokeRecord(smokeRecord(payload).result).list).map(row => normalizeBybitKline(row, {
      symbol: 'BTCUSDT', interval: '1h', receivedAt,
    }));
    const first = candles[0];
    results.klines = {
      http: response.status,
      retCode: smokeRecord(payload).retCode,
      rows: candles.length,
      first: first && {
        start: first.start,
        open: first.open,
        high: first.high,
        low: first.low,
        close: first.close,
        volume: first.volume,
      },
    };
  } else {
    const normalized = normalizeBybitOpenInterest(payload, { receivedAt });
    results.openInterest = {
      http: response.status,
      retCode: smokeRecord(payload).retCode,
      instrumentId: normalized.instrumentId,
      base: normalized.base,
      quote: normalized.quote,
      sourceTimestamp: normalized.sourceTimestamp,
      quality: normalized.quality,
    };
  }
}

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
