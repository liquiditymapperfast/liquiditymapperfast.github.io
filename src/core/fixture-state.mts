import type { RuntimeState } from '../domain/runtime-state.mts';
type FixtureState = Pick<RuntimeState, 'asOf' | 'markPrice' | 'markets' | 'books' | 'layers' | 'oi' | 'candles' | 'statuses'>;
import { normalizeMarket } from './normalize.mts';
const NOW = 1_757_500_000_000;
const HOUR = 3_600_000;
function fixtureMarket({ venue, nativeSymbol, symbol = nativeSymbol, base = 'BTC', quote = 'USDT', marketType = 'perpetual', tickSize = 0.1, aggregationId = 1 }: { venue: string; nativeSymbol: string; symbol?: string; base?: string; quote?: string; marketType?: string; tickSize?: number; aggregationId?: number }) {
  const id = `${venue}:${nativeSymbol}`;
  return { id, instrumentId: id, venue, exchange: venue, nativeSymbol, symbol, base, quote, baseNormalized: base, quoteNormalized: quote, marketType, tickSize, quantityUnit: 'base', isFree: true, aggregationId };
}
export const FIXTURE_MARKETS = [
  normalizeMarket({venue:'hyperliquid',nativeSymbol:'BTC-PERP',symbol:'BTC-PERP',base:'BTC',quote:'USD',marketType:'perpetual',tickSize:0.1,aggregationId:1}),
  normalizeMarket({venue:'binance',nativeSymbol:'BTCUSDT',symbol:'BTCUSDT',base:'BTC',quote:'USDT',marketType:'perpetual',tickSize:0.1,aggregationId:1}),
  normalizeMarket({venue:'binance',nativeSymbol:'BTCUSDT',symbol:'BTCUSDT',base:'BTC',quote:'USDT',marketType:'spot',tickSize:0.01,aggregationId:2}),
  fixtureMarket({ venue: 'bybit', nativeSymbol: 'BTCUSDT', quote: 'USDT' }),
  fixtureMarket({ venue: 'okx', nativeSymbol: 'BTC-USDT-SWAP', quote: 'USDT' }),
];
function fixtureCandles(instrumentId: string) {
  const rows = []; let prior = 76_900;
  for (let index = 0; index < 72; index += 1) {
    const start = NOW - (72 - index) * HOUR;
    const open = prior;
    const target = 77_300 + Math.sin(index * 0.19) * 520 + Math.sin(index * 0.53) * 125;
    const close = index === 71 ? 77_300 : Math.max(70_000, target);
    const high = Math.max(open, close) + 75 + (index % 5) * 13;
    const low = Math.min(open, close) - 68 - (index % 4) * 11;
    const row = { kind: 'candle', instrumentId, interval: '1h', start, end: start + HOUR, open, high, low, close, volume: 320 + (index % 9) * 27, sourceTimestamp: start + HOUR, receivedAt: start + HOUR + 100, source: 'fixture', quality: 'fixture', closed: true };
    rows.push(row); prior = close;
  }
  return rows;
}
const FIXTURE_CANDLES = {
  'hyperliquid:BTC-PERP': fixtureCandles('hyperliquid:BTC-PERP'),
  'binance:BTCUSDT': fixtureCandles('binance:BTCUSDT'),
  'binance:BTCUSDT:spot': fixtureCandles('binance:BTCUSDT:spot'),
};
function fixtureBook({ sequence, bidBase, askBase, bidStep = 0.18, askStep = 0.16 }: { sequence: number; bidBase: number; askBase: number; bidStep?: number; askStep?: number }) {
  const bids = Array.from({ length: 24 }, (_, index): [number, number] => [77_300 - (index + 1) * 25, bidBase + index * bidStep]);
  const asks = Array.from({ length: 24 }, (_, index): [number, number] => [77_300 + (index + 1) * 25, askBase + index * askStep]);
  return { complete: true, sequence, sourceTimestamp: NOW, coverage: 'partial', bids, asks };
}
export const FIXTURE_STATE: Readonly<FixtureState> = Object.freeze<FixtureState>({
  asOf: NOW, markPrice: 77_300, markets: FIXTURE_MARKETS,
  books: {
    'hyperliquid:BTC-PERP': fixtureBook({ sequence: 100, bidBase: 2.1, askBase: 1.7, bidStep: 0.15, askStep: 0.11 }),
    'binance:BTCUSDT': fixtureBook({ sequence: 200, bidBase: 4.2, askBase: 3.1, bidStep: 0.22, askStep: 0.17 }),
    'bybit:BTCUSDT': fixtureBook({ sequence: 300, bidBase: 3.4, askBase: 2.8, bidStep: 0.19, askStep: 0.14 }),
    'okx:BTC-USDT-SWAP': fixtureBook({ sequence: 400, bidBase: 2.7, askBase: 3.8, bidStep: 0.13, askStep: 0.21 })
  },
  layers: {
    liquidation: [
      {id:'liq-long-77000',layer:'liquidation',side:'long',price:77000,amount:100,notionalUsd:7_700_000,active:true,sourceTimestamp:NOW-60000},
      {id:'liq-short-78000',layer:'liquidation',side:'short',price:78000,amount:80,notionalUsd:6_240_000,active:true,sourceTimestamp:NOW-60000}
    ],
    stopLoss: [
      {id:'sl-sell-76800',layer:'stopLoss',side:'sell',price:76800,amount:50,notionalUsd:3_840_000,active:true,sourceTimestamp:NOW-60000},
      {id:'sl-buy-78100',layer:'stopLoss',side:'buy',price:78100,amount:65,notionalUsd:5_070_000,active:true,sourceTimestamp:NOW-60000}
    ],
    takeProfit: [
      {id:'tp-sell-79000',layer:'takeProfit',side:'sell',price:79000,amount:40,notionalUsd:3_160_000,active:true,sourceTimestamp:NOW-60000},
      {id:'tp-buy-76000',layer:'takeProfit',side:'buy',price:76000,amount:30,notionalUsd:2_280_000,active:true,sourceTimestamp:NOW-60000}
    ]
  },
  oi: Array.from({length: 12}, (_, i) => ({kind:'openInterest',instrumentId:'hyperliquid:BTC-PERP',sourceTimestamp:NOW-(11-i)*3_600_000,receivedAt:NOW-(11-i)*3_600_000+100,base:100_000+i*350,quote:100_000*77_000+i*25_000_000,quality:'fixture'})),
  candles: FIXTURE_CANDLES,
  statuses: { hyperliquid:{state:'live',lastSuccess:NOW,gaps:0}, binance:{state:'snapshot',lastSuccess:NOW,gaps:0}, bybit:{state:'live',lastSuccess:NOW,gaps:0}, okx:{state:'live',lastSuccess:NOW,gaps:0} }
});
export function cloneFixtureState(): FixtureState { return structuredClone(FIXTURE_STATE); }
