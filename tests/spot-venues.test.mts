import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_VENUES, BitgetConnector, BitgetSpotConnector, BybitSpotConnector, OkxConnector, OkxSpotConnector, restoreSelection } from '../src/shared/venues.ts';
import type { BookConnector, TradeEvent } from '../src/shared/connector.ts';
import { fetchCandles } from '../src/shared/history.ts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';
import { CONNECTOR_FACTORIES } from '../src/server/v2/connectors.mts';
import { RECOMMENDED_EXTRA_VENUES } from '../src/server/v2/venues.mts';

type Inside = { url(): string; open(send: (p: unknown) => void): void; usdOf(price: number, size: number): number };
const inside = (c: BookConnector): Inside => c as unknown as Inside;
const trades = (c: BookConnector): TradeEvent[] => { const out: TradeEvent[] = []; c.onTrade = t => { out.push(t); }; return out; };
const msg = (value: unknown): string => JSON.stringify(value);

test('OKX spot sizes are BTC, not contracts, while the swap keeps its contract size', () => {
  const spot = new OkxSpotConnector(), swap = new OkxConnector();
  assert.equal(spot.instrumentId, 'okxspot:BTC-USDT'); assert.equal(spot.marketType, 'spot');
  const got = trades(spot);
  spot.onMessage(msg({ arg: { channel: 'trades', instId: 'BTC-USDT' }, data: [{ tradeId: '1', px: '80000', sz: '0.5', side: 'sell', ts: '1700000000000' }] }));
  assert.deepEqual(got.map(t => [t.side, t.amount, t.notionalUsd]), [['sell', 0.5, 40_000]], '0.5 BTC is $40,000, not $400');
  assert.equal(inside(spot).usdOf(80_000, 1), 80_000, 'a book level of 1 BTC');
  assert.equal(inside(swap).usdOf(80_000, 1), 800, 'the swap: one contract is 0.01 BTC');
  const sent: unknown[] = []; inside(spot).open(p => sent.push(p));
  assert.deepEqual(sent, [{ op: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT' }, { channel: 'trades', instId: 'BTC-USDT' }] }]);
});

test('Bybit spot is the spot stream, and its seq names the order its fills belong to', () => {
  const c = new BybitSpotConnector();
  assert.equal(c.instrumentId, 'bybitspot:BTCUSDT'); assert.equal(inside(c).url(), 'wss://stream.bybit.com/v5/public/spot');
  const got = trades(c);
  c.onMessage(msg({ topic: 'publicTrade.BTCUSDT', data: [{ i: 'a', T: 1700000000000, p: '80000', v: '0.25', S: 'Buy', seq: 77 }, { i: 'b', T: 1700000000000, p: '80001', v: '0.25', S: 'Buy', seq: 77 }] }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.notionalUsd, t.order]), [['a', 'buy', 20_000, '77'], ['b', 'buy', 20_000.25, '77']]);
});

test('Bitget leaves out the trades it sends as a snapshot on subscribing, on spot and on the perpetual', () => {
  for (const c of [new BitgetSpotConnector(), new BitgetConnector()]) {
    const got = trades(c);
    c.onMessage(msg({ action: 'snapshot', arg: { channel: 'trade' }, data: [{ tradeId: 'old', price: '80000', size: '1', side: 'buy', ts: '1700000000000' }] }));
    c.onMessage(msg({ action: 'update', arg: { channel: 'trade' }, data: [{ tradeId: 'new', price: '80000', size: '0.1', side: 'sell', ts: '1700000000001' }] }));
    assert.deepEqual(got.map(t => t.tradeId), ['new'], c.id);
  }
  const sent: unknown[] = []; inside(new BitgetSpotConnector()).open(p => sent.push(p));
  assert.deepEqual(sent, [{ op: 'subscribe', args: [{ instType: 'SPOT', channel: 'books', instId: 'BTCUSDT' }, { instType: 'SPOT', channel: 'trade', instId: 'BTCUSDT' }] }]);
});

test('the three spot markets are recommended, in the browser and on the server, and each is a connector the server can make', () => {
  for (const id of ['bybitspot', 'okxspot', 'bitgetspot']) {
    const venue = BROWSER_VENUES.find(v => v.id === id);
    assert.ok(venue?.recommended, id); assert.equal(venue.kind, 'spot');
    assert.ok(RECOMMENDED_EXTRA_VENUES.includes(id), id); assert.ok(CONNECTOR_FACTORIES[id], id);
    assert.equal(CONNECTOR_FACTORIES[id]!().marketType, 'spot');
  }
});

test('a saved venue choice gains the recommended venues added since it was made, and keeps out one it had seen and left out', () => {
  const venues = [{ id: 'binance', recommended: true }, { id: 'coinbase', recommended: true }, { id: 'okxspot', recommended: true }, { id: 'small', recommended: false }];
  assert.equal(restoreSelection(null, null, venues), null, 'no saved choice: the recommended set');
  assert.deepEqual(restoreSelection(['binance'], null, venues), ['binance', 'okxspot'], 'a save from before the list was kept knew the first eight');
  assert.deepEqual(restoreSelection(['binance'], ['binance', 'coinbase', 'okxspot', 'small'], venues), ['binance'], 'seen and left out: stays out');
  assert.deepEqual(restoreSelection(['binance', 'okxspot'], ['binance', 'coinbase'], venues), ['binance', 'okxspot'], 'never twice');
});

test('the server opens no second socket for the spot venues: their connector venues carry their own trades', () => {
  const sources = new FlowSources(() => {});
  try {
    sources.sync(new Set(['bybitspot:BTCUSDT', 'okxspot:BTC-USDT', 'bitgetspot:BTCUSDT']));
    assert.deepEqual(sources.active, []);
  } finally { sources.close(); }
});

test('spot candles: OKX spot volume is the coin column, and Bitget spot names its intervals its own way', async () => {
  const asked: string[] = [];
  const okx = await fetchCandles('okxspot:BTC-USDT', 60_000, 0, 120_000, async url => { asked.push(url); return { data: [['60000', '1', '2', '0.5', '1.5', '3.25', '260000', '260000', '1']] }; });
  assert.equal(okx[0]?.[5], 3.25, 'BTC, not USDT');
  assert.match(asked[0]!, /instId=BTC-USDT&/);
  await fetchCandles('bitgetspot:BTCUSDT', 60_000, 0, 120_000, async url => { asked.push(url); return { data: [] }; });
  assert.match(asked.find(u => u.includes('bitget')) ?? '', /spot\/market\/candles\?symbol=BTCUSDT&granularity=1min&/);
  await fetchCandles('bybitspot:BTCUSDT', 60_000, 0, 120_000, async url => { asked.push(url); return { result: { list: [] } }; });
  assert.match(asked.find(u => u.includes('bybit')) ?? '', /category=spot&symbol=BTCUSDT&interval=1&/);
});
