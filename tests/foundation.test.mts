import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { cloneFixtureState } from '../src/core/fixture-state.mts';
import { MAX_QUOTA_LEDGER_LABEL_BYTES, MAX_QUOTA_LEDGER_REQUESTS, QuotaLedger } from '../src/core/quota.mts';
import { applyBookDelta, bookFromSnapshot, sortedBook } from '../src/core/normalize.mts';
import type { CrossingLevel } from '../src/core/crossing.mts';
import { applyMarkPrice } from '../src/core/crossing.mts';

test('fixture state has both native venues and all requested layers', () => {
  const state = cloneFixtureState();
  assert.equal(state.markPrice, 77300);
  assert.deepEqual(state.markets.map(x => x.venue), ['hyperliquid','binance','binance','bybit','okx']);
  assert.equal(new Set(state.markets.map(x => x.id)).size, state.markets.length);
  assert.deepEqual(Object.keys(state.layers), ['liquidation','stopLoss','takeProfit']);
  assert.equal(state.oi.length, 12);
});

test('book delta applies updates and detects sequence gaps', () => {
  const book = bookFromSnapshot({sequence:5,complete:true,bids:[{price:100,amount:2}],asks:[{price:101,amount:1}]});
  const next = applyBookDelta(book, {sequence:6,previousSequence:5,bids:[[100,0],[99,3]],asks:[[102,4]]});
  assert.deepEqual(sortedBook(next), {bids:[[99,3]], asks:[[101,1],[102,4]]});
  assert.equal(applyBookDelta(book,{sequence:9,previousSequence:8,bids:[],asks:[]}).status,'gap');
});

test('local crossing fades levels without an API call', () => {
  const levels = cloneFixtureState().layers.liquidation;
  const updated = applyMarkPrice(levels, 78100, 76900, 123);
  assert.equal((updated.find(x => x.id === 'liq-long-77000'))!.active, false);
  assert.equal((updated.find(x => x.id === 'liq-long-77000'))!.provisional, true);
  assert.equal((updated.find(x => x.id === 'liq-short-78000'))!.active, true);
  const retraced = applyMarkPrice(updated, 76900, 78100, 124);
  assert.equal((retraced.find(x => x.id === 'liq-long-77000'))!.active, false);
  assert.equal((retraced.find(x => x.id === 'liq-short-78000'))!.active, false);
});

test('take-profit sides cross in their execution direction', () => {
  const levels = cloneFixtureState().layers.takeProfit;
  const up = applyMarkPrice(levels, 78900, 79000, 123);
  const down = applyMarkPrice(levels, 76100, 76000, 124);
  assert.equal((up.find(x => x.id === 'tp-sell-79000'))!.active, false);
  assert.equal((down.find(x => x.id === 'tp-buy-76000'))!.active, false);
});

test('coarse provider buckets require crossing the far edge', () => {
  const level: CrossingLevel = { id: 'bucket', layer: 'liquidation', side: 'long', price: 10, priceLow: 10, priceHigh: 20, active: true };
  assert.equal(applyMarkPrice([level], 25, 15, 1)[0].active, true);
  assert.equal(applyMarkPrice([level], 25, 10, 2)[0].active, false);
});

test('quota ledger caps requests and rolls by UTC day', () => {
  const t = Date.parse('2026-01-02T12:00:00Z');
  const q = new QuotaLedger({ limit: 20, now: t });
  assert.equal(q.spend(15,'snapshot',t),true); assert.equal(q.spend(6,'retry',t),false); assert.equal(q.snapshot(t).remaining,5);
  assert.equal(q.spend(1,'next',t+86_400_000),true); assert.equal(q.snapshot(t+86_400_000).used,1);
});