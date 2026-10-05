import test from 'node:test';
import assert from 'node:assert/strict';
import { binanceInstrumentId, buildBinanceRequest, buildBinanceSubscription, normalizeBinanceExchangeInfo, normalizeBinanceDepth, normalizeBinanceDepthDelta, normalizeBinanceAggTrade, normalizeBinanceKline, normalizeBinanceOpenInterest, normalizeBinanceOpenInterestHistory } from '../src/adapters/binance.mts';
import { usdBookLevels } from '../src/core/book-valuation.mts';

const at = 1_790_000_000_000, symbol = 'BTCUSD_PERP';
const row = { symbol, pair: 'BTCUSD', contractType: 'PERPETUAL', contractStatus: 'TRADING', contractSize: 100, baseAsset: 'BTC', quoteAsset: 'USD', marginAsset: 'BTC', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '1' }] };
const metadata = normalizeBinanceExchangeInfo({ symbols: [row], serverTime: at }, { symbol, family: 'coinm', receivedAt: at }).assets[0]!;
const options = { symbol, family: 'coinm', metadata, receivedAt: at };
const depth = { symbol, lastUpdateId: 100, E: at, T: at, bids: [['50000','2']], asks: [['50100','3']] };
const delta = { e: 'depthUpdate', s: symbol, U: 101, u: 102, pu: 100, E: at, b: [['50000','0']], a: [['50100','4']] };
const trade = { e: 'aggTrade', s: symbol, a: 1, T: at, p: '50000', q: '3', m: false };
const historyRow = { pair: 'BTCUSD', contractType: 'PERPETUAL', sumOpenInterest: '100', sumOpenInterestValue: '0.2', timestamp: at };

test('COIN-M builders use explicit public family without changing legacy IDs or endpoints', () => {
  assert.equal(new URL(buildBinanceRequest('depth', options).url).origin, 'https://dapi.binance.com');
  assert.equal(new URL(buildBinanceRequest('depth', options).url).pathname, '/dapi/v1/depth');
  assert.equal(new URL(buildBinanceRequest('exchangeInfo', options).url).pathname, '/dapi/v1/exchangeInfo');
  assert.equal(buildBinanceRequest('exchangeInfo', options).responseClass, 'catalog');
  assert.equal(new URL(buildBinanceRequest('klines', { ...options, interval: '1m' }).url).pathname, '/dapi/v1/klines');
  assert.equal(new URL(buildBinanceRequest('openInterest', options).url).pathname, '/dapi/v1/openInterest');
  assert.equal(buildBinanceSubscription('depth', options).url, 'wss://dstream.binance.com/ws/btcusd_perp@depth@100ms');
  assert.equal(buildBinanceSubscription('aggTrade', options).url, 'wss://dstream.binance.com/ws/btcusd_perp@aggTrade');
  assert.equal(binanceInstrumentId(symbol, 'perpetual', 'coinm'), 'binance:BTCUSD_PERP');
  assert.equal(binanceInstrumentId('BTCUSDT'), 'binance:BTCUSDT');
  assert.equal(binanceInstrumentId('BTCUSDT', 'spot'), 'binance:BTCUSDT:spot');
  assert.equal(new URL(buildBinanceRequest('depth', { symbol:'BTCUSDT' }).url).origin, 'https://fapi.binance.com');
  assert.throws(() => buildBinanceRequest('depth', { symbol, family:'unknown' }), /family/);
  assert.throws(() => buildBinanceSubscription('depth', { symbol, family:'coinm', marketType:'spot' }), /spot/);
});

test('COIN-M metadata uses exchange filters, retains inactive rows and identifies inverse settlement', () => {
  assert.equal(metadata.quantityUnit, 'contract'); assert.equal(metadata.contractValue, 100);
  assert.equal(metadata.contractType, 'inverse'); assert.equal(metadata.exchangeContractType, 'PERPETUAL');
  assert.equal(metadata.inverse, true); assert.equal(metadata.tickSize, 0.1); assert.equal(metadata.lotSize, 1);
  assert.equal(metadata.family, 'coinm'); assert.equal(metadata.pair, 'BTCUSD'); assert.equal(metadata.settleCoin, 'BTC');
  const inactive = normalizeBinanceExchangeInfo({ symbols:[{ ...row, contractStatus:'DELIVERED' }] }, options).assets[0]!;
  assert.equal(inactive.isDelisted, true); assert.equal(inactive.status, 'DELIVERED');
  assert.throws(() => normalizeBinanceDepth(depth, { ...options, metadata: inactive }), /active verified/);
  const delivery = normalizeBinanceExchangeInfo({ symbols:[{ ...row, symbol:'BTCUSD_261225', contractType:'CURRENT_QUARTER' }] }, { family:'coinm' }).assets[0]!;
  assert.equal(delivery.marketType, 'delivery'); assert.equal(delivery.instrumentId, 'binance:BTCUSD_261225');
  assert.equal(delivery.exchangeContractType, 'CURRENT_QUARTER');
});

test('COIN-M metadata rejects absent multiplier, malformed filters and conflicting settlement', () => {
  for (const contractSize of [undefined, null, true, 0, -1, 'NaN', Number.POSITIVE_INFINITY]) assert.throws(() => normalizeBinanceExchangeInfo({ symbols:[{ ...row, contractSize }] }, options));
  for (const patch of [{ quoteAsset:'USDT' }, { marginAsset:'USDT' }, { baseAsset:true }, { contractType:'UNKNOWN' }, { filters:[{ filterType:'PRICE_FILTER', tickSize:true }, { filterType:'LOT_SIZE', stepSize:'1' }] }]) assert.throws(() => normalizeBinanceExchangeInfo({ symbols:[{ ...row, ...patch }] }, options));
  assert.deepEqual(normalizeBinanceExchangeInfo({ symbols:[row] }, { ...options, symbol:'ETHUSD_PERP' }).assets, []);
});

test('COIN-M depth retains contracts and values USD using verified inverse metadata', () => {
  const book = normalizeBinanceDepth(depth, options);
  assert.equal(book.units, 'contract'); assert.equal(book.contractValue, 100);
  assert.equal(book.inverse, true); assert.equal(book.sequence, 100); assert.equal(book.bids[0]?.amount, 2);
  const rows = usdBookLevels({ ...book, bids:book.bids.map(r=>[r.price,r.amount]), asks:book.asks.map(r=>[r.price,r.amount]) }, metadata);
  assert.equal(rows.find(r=>r.side==='bid')?.notionalUsd, 200);
  assert.equal(rows.find(r=>r.side==='bid')?.amount, .004);
  assert.equal(rows.find(r=>r.side==='ask')?.notionalUsd, 300);
});

test('COIN-M depth rejects missing or foreign contract metadata and unsafe identities', () => {
  for (const bad of [undefined, { ...metadata, nativeSymbol:'ETHUSD_PERP' }, { ...metadata, family:'usdm' }, { ...metadata, quantityUnit:'base' }, { ...metadata, inverse:false }, { ...metadata, contractValue:0 }]) assert.throws(() => normalizeBinanceDepth(depth, { ...options, metadata:bad }));
  assert.throws(() => normalizeBinanceDepth({ ...depth, symbol:'ETHUSD_PERP' }, options), /symbol mismatch/);
  assert.throws(() => normalizeBinanceDepth({ ...depth, lastUpdateId:Number.MAX_SAFE_INTEGER+1 }, options), /update ID/);
  for (const bids of [[[true,'1']], [['50000',true]], [['50000','-1']], [[0,'1']]]) assert.throws(() => normalizeBinanceDepth({ ...depth, bids }, options));
});

test('COIN-M deltas require actual pu and preserve zero deletion in contract units', () => {
  const message=normalizeBinanceDepthDelta(delta,options);
  assert.equal(message.units,'contract'); assert.equal(message.contractValue,100);
  assert.equal(message.bids[0]?.amount,0); assert.equal(message.previousSequence,100);
  assert.equal(message.firstUpdate,101); assert.equal(message.sequence,102);
  assert.throws(()=>normalizeBinanceDepthDelta({ ...delta, pu:undefined },options),/previous update/);
  assert.throws(()=>normalizeBinanceDepthDelta({ ...delta, s:'ETHUSD_PERP' },options),/symbol mismatch/);
});

test('COIN-M trade quote notional derives from contract multiplier and base amount from execution price',()=>{
  const normalized=normalizeBinanceAggTrade(trade,options);
  assert.equal(normalized.notionalUsd,300); assert.equal(normalized.amount,.006);
  assert.equal(normalized.nativeAmount,3); assert.equal(normalized.units,'contract'); assert.equal(normalized.side,'buy');
  assert.equal(normalized.instrumentId,'binance:BTCUSD_PERP');
  assert.throws(()=>normalizeBinanceAggTrade({ ...trade,s:'ETHUSD_PERP' },options),/symbol mismatch/);
  assert.throws(()=>normalizeBinanceAggTrade(trade,{ ...options,metadata:undefined }),/verified/);
});

test('COIN-M REST and stream candles report observed base volume rather than contract volume',()=>{
  const rest=normalizeBinanceKline([at,'50000','51000','49000','50500','100',at+59999,'0.2'],{ ...options,interval:'1m' });
  assert.equal(rest.volume,.2); assert.equal(rest.sourceTimestamp,at+59999);
  const stream=normalizeBinanceKline({ s:symbol,t:at,T:at+59999,o:'50000',h:'51000',l:'49000',c:'50500',v:'100',q:'0.2',x:true },{ ...options,interval:'1m' });
  assert.equal(stream.volume,.2); assert.equal(stream.closed,true);
  assert.throws(()=>normalizeBinanceKline([at,'50000','51000','49000','50500','100',at+59999],{ ...options,interval:'1m' }),/volume/);
  assert.throws(()=>normalizeBinanceKline({ s:'ETHUSD_PERP',t:at,T:at+59999,o:'50000',h:'51000',l:'49000',c:'50500',v:'100',q:'0.2' },{ ...options,interval:'1m' }),/symbol mismatch/);
});

test('COIN-M OI uses contract quote value and explicit observed price for base conversion',()=>{
  const normalized=normalizeBinanceOpenInterest({ symbol,openInterest:'100',time:at },{ ...options,markPrice:50000 });
  assert.equal(normalized.quote,10000); assert.equal(normalized.base,.2);
  assert.equal(normalized.sourceTimestamp,at);
  assert.throws(()=>normalizeBinanceOpenInterest({ symbol,openInterest:'100',time:at },options),/price basis/);
  assert.throws(()=>normalizeBinanceOpenInterest({ symbol:'ETHUSD_PERP',openInterest:'100',time:at },{ ...options,markPrice:50000 }),/symbol mismatch/);
  for (const openInterest of [null,true,-1,'NaN',1e308]) assert.throws(()=>normalizeBinanceOpenInterest({ symbol,openInterest,time:at },{ ...options,markPrice:50000 }));
});

test('COIN-M OI history queries a verified pair and contract family and respects base-valued history',()=>{
  const url=new URL(buildBinanceRequest('openInterestHistory',{ ...options,period:'5m' }).url);
  assert.equal(url.origin,'https://dapi.binance.com'); assert.equal(url.pathname,'/futures/data/openInterestHist');
  assert.equal(url.searchParams.get('pair'),'BTCUSD'); assert.equal(url.searchParams.get('contractType'),'PERPETUAL');
  assert.equal(url.searchParams.has('symbol'),false);
  const sample=normalizeBinanceOpenInterestHistory([historyRow],options)[0]!;
  assert.equal(sample.base,.2); assert.equal(sample.quote,10000); assert.equal(sample.quality,'sampled');
  assert.throws(()=>normalizeBinanceOpenInterestHistory([{ ...historyRow,pair:'ETHUSD' }],options),/family mismatch/);
  assert.throws(()=>normalizeBinanceOpenInterestHistory([{ ...historyRow,contractType:'ALL' }],options),/family mismatch/);
  assert.throws(()=>normalizeBinanceOpenInterestHistory([{ ...historyRow,sumOpenInterestValue:undefined }],options),/base asset value/);
  assert.throws(()=>normalizeBinanceOpenInterestHistory([{ ...historyRow,sumOpenInterest:1e308 }],options),/overflows/);
});
