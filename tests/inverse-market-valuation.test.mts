import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { usdBookLevels } from '../src/core/book-valuation.mts';
import { normalizeBinanceExchangeInfo, normalizeBinanceDepth } from '../src/adapters/binance.mts';

const symbol='BTCUSD_PERP', instrumentId='binance:BTCUSD_PERP';
const metadata=normalizeBinanceExchangeInfo({ symbols:[{ symbol,pair:'BTCUSD',contractType:'PERPETUAL',contractStatus:'TRADING',contractSize:100,baseAsset:'BTC',quoteAsset:'USD',marginAsset:'BTC',filters:[{ filterType:'PRICE_FILTER',tickSize:'0.1' },{ filterType:'LOT_SIZE',stepSize:'1' }] }] },{ symbol,family:'coinm' });

test('inverse metadata survives initial market registration and exact runtime book valuation', async t => {
  const app=createLocalServer({ history:new HistoryStore({ filePath:':memory:' }),quota:new QuotaLedger({ filePath:null }),persistFixture:false });
  t.after(()=>app.close());
  app.applyMessage(metadata,'binance');
  assert.equal(app.state.metadata.binance?.kind,'metadata');
  const snapshot=normalizeBinanceDepth({ symbol,lastUpdateId:100,E:Date.now(),bids:[['50000','2']],asks:[['50100','3']] },{ symbol,family:'coinm',metadata:metadata.assets[0] });
  assert.equal(app.applyMessage(snapshot,'binance'),true);
  const market=app.state.markets.find(value=>(value.instrumentId ?? value.id)===instrumentId);
  assert.ok(market); assert.equal(market.quantityUnit,'contract');
  assert.equal(market.contractType,'inverse'); assert.equal(market.inverse,true);
  const book=app.state.books[instrumentId]; assert.ok(book);
  const levels=usdBookLevels(book,market);
  assert.equal(levels.find(value=>value.side==='bid')?.notionalUsd,200);
  assert.equal(levels.find(value=>value.side==='bid')?.amount,.004);
  assert.equal(levels.find(value=>value.side==='ask')?.notionalUsd,300);
});

test('late inverse metadata corrects a pre-existing contract placeholder without changing depth amounts',async t=>{
  const app=createLocalServer({ history:new HistoryStore({ filePath:':memory:' }),quota:new QuotaLedger({ filePath:null }),persistFixture:false });
  t.after(()=>app.close());
  assert.equal(app.applyMessage({ kind:'depthSnapshot',instrumentId,sourceTimestamp:Date.now(),receivedAt:Date.now(),sequence:1,units:'contract',complete:true,bids:[{ price:50000,amount:2 }],asks:[{ price:50100,amount:3 }] },'binance'),true);
  const before=app.state.books[instrumentId]; assert.ok(before); assert.deepEqual(before.bids,[[50000,2]]);
  app.applyMessage(metadata,'binance');
  assert.equal(app.state.metadata.binance?.kind,'metadata');
  const market=app.state.markets.find(value=>(value.instrumentId ?? value.id)===instrumentId);
  assert.ok(market); assert.equal(market.contractType,'inverse'); assert.equal(market.inverse,true);
  assert.equal(market.contractValue,100);
  const after=app.state.books[instrumentId]; assert.ok(after); assert.deepEqual(after.bids,[[50000,2]]);
  assert.equal(usdBookLevels(after,market).find(value=>value.side==='bid')?.notionalUsd,200);
});

test('bounded restart market payload keeps inverse contract and USD conversion metadata', t => {
  const history = new HistoryStore({ filePath: ':memory:' }); t.after(() => history.close());
  history.recordState({ asOf: 1000, markPrice: 50000, markets: [{ ...metadata.assets[0], quoteToUsd: 1 }], layers: {}, statuses: {} });
  const restored = history.latestState(); assert.ok(restored);
  const markets = restored.markets; assert.ok(Array.isArray(markets));
  const market = markets[0]; assert.ok(market && typeof market === 'object');
  assert.equal(market.contractType, 'inverse'); assert.equal(market.inverse, true);
  assert.equal(market.contractValue, 100); assert.equal(market.quoteToUsd, 1);
});
