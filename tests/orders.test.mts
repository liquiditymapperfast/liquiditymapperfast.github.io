import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrderBuilder, ORDER_QUIET_MS, orderRow, venueOrderKey, type MarketOrder } from '../src/shared/orders.ts';
import { PrintStream, spanOf, toWire } from '../src/shared/prints.ts';
import { FootprintRecorder } from '../src/shared/footprint.ts';
import { SqlitePrintStore } from '../src/server/v2/prints.mts';
import { BybitConnector, CoinbaseConnector, HyperliquidConnector } from '../src/shared/venues.ts';
import type { TradeEvent } from '../src/shared/connector.ts';
import { fromWire, printPriceLines } from '../src/app/prints.ts';

const T0 = 1_800_000_000_000;
const fill = (tradeId: string, price: number, usd: number, t: number, more: Record<string, unknown> = {}) => ({ instrumentId: 'v:BTC', tradeId, side: 'buy', price, notionalUsd: usd, sourceTimestamp: t, ...more });

test('the fills of one market order become one order: its size, its average price, the prices it reached and how many fills it took', () => {
  let now = 0;
  const builder = new OrderBuilder(() => now);
  // Bybit-style: three fills of one order (one key), walking the book from 100 to 101.
  builder.add([fill('1', 100, 10_000, T0, { order: 'seq-7' }), fill('2', 100.5, 10_000, T0, { order: 'seq-7' }), fill('3', 101, 10_000, T0 + 1, { order: 'seq-7' })]);
  assert.deepEqual(builder.drain(), [], 'nothing is complete while the order may still be filling');
  builder.add([fill('4', 101, 5_000, T0 + 2, { order: 'seq-8' })]);
  const [order] = builder.drain();
  assert.ok(order, 'another order on the same instrument closes the first');
  assert.equal(order.tradeId, '1'); assert.equal(order.t, T0); assert.equal(order.side, 'buy');
  assert.equal(order.usd, 30_000); assert.equal(order.fills, 3); assert.equal(order.lo, 100); assert.equal(order.hi, 101);
  const coins = 10_000 / 100 + 10_000 / 100.5 + 10_000 / 101;
  assert.ok(Math.abs(order.price - 30_000 / coins) < 1e-9, 'volume-weighted price');
  now = ORDER_QUIET_MS - 1; assert.deepEqual(builder.drain(), [], 'the second is not complete yet');
  now = ORDER_QUIET_MS; assert.equal(builder.drain()[0]!.tradeId, '4', 'a quiet spell completes it');
});

test('without a key the exchange millisecond and the side name the order; an all-zero hash names nothing; a replayed fill is taken once', () => {
  const builder = new OrderBuilder(() => 0);
  const taken = builder.add([
    fill('a', 100, 1_000, T0), fill('b', 100.1, 1_000, T0), fill('c', 100, 1_000, T0, { side: 'sell' }), fill('d', 100, 1_000, T0 + 1),
    fill('e', 100, 1_000, T0 + 2, { hash: '0x0000000000' }), fill('f', 100, 1_000, T0 + 2, { hash: '0x00' }),
    fill('g', 100, 1_000, T0 + 3, { hash: '0xabc' }), fill('h', 100, 1_000, T0 + 9, { hash: '0xabc' }),
    fill('a', 100, 1_000, T0), // a replay after a reconnect
    { instrumentId: 'v:BTC', tradeId: 'bad', side: 'buy', price: 0, notionalUsd: 5, sourceTimestamp: T0 },
  ]);
  assert.equal(taken.length, 8, 'the replay and the bad row are not taken');
  const orders = builder.drain(true);
  assert.deepEqual(orders.map(o => [o.tradeId, o.side, o.fills]), [['a', 'buy', 2], ['c', 'sell', 1], ['d', 'buy', 1], ['e', 'buy', 2], ['g', 'buy', 2]]);
  assert.equal(venueOrderKey({ hash: '0x0000' }), null); assert.equal(venueOrderKey({ order: '' }), null); assert.equal(venueOrderKey({ order: 42 }), '42');
});

test('instruments keep their own orders, and the orders come out oldest first', () => {
  const builder = new OrderBuilder(() => 0);
  builder.add([fill('1', 100, 1_000, T0 + 5), { ...fill('2', 100, 1_000, T0), instrumentId: 'w:BTC' }, fill('3', 100, 1_000, T0 + 5)]);
  const orders = builder.drain(true);
  assert.deepEqual(orders.map(o => [o.instrumentId, o.fills]), [['w:BTC', 1], ['v:BTC', 2]]);
});

test('a print is a market order: a large order of small fills prints, with its span and fill count, and old rows stay single fills', () => {
  const builder = new OrderBuilder(() => 0), prints = new PrintStream(null, () => T0);
  builder.add(Array.from({ length: 30 }, (_, i) => fill(String(i), 100 + i * 0.1, 10_000, T0, { order: 'big' })));
  builder.add([fill('x', 100, 20_000, T0 + 50)]);
  const added = prints.ingest(builder.drain(true).map(orderRow));
  assert.equal(added.length, 1, 'thirty fills of $10K are one $300K order; the lone $20K fill is under the floor');
  const [p] = added;
  assert.equal(p!.usd, 300_000); assert.equal(p!.n, 30); assert.equal(p!.lo, 100); assert.ok(Math.abs(p!.hi! - 102.9) < 1e-9);
  assert.equal(toWire(p!).length, 8);
  const back = fromWire(JSON.parse(JSON.stringify(toWire(p!))));
  assert.deepEqual(back, p, 'the page reads the span and the count back');
  const single = prints.ingest([fill('solo', 100, 50_000, T0 + 100)])[0]!;
  assert.deepEqual(toWire(single), [T0 + 100, 'v:BTC', 'buy', 100, 50_000], 'a single fill is sent as before');
  assert.deepEqual(fromWire([T0, 'v:BTC', 'buy', 100, 50_000, 101, 102, 3]), { t: T0, id: 'v:BTC', side: 'buy', price: 100, usd: 50_000 }, 'a span that does not hold the price is dropped, the print kept');
  assert.equal(spanOf({ price: 100, lo: 99, hi: 101, fills: 1 }), null, 'one fill has no span');
  assert.deepEqual(spanOf({ price: 100, lo: 99, hi: 101, fills: 4 }), { lo: 99, hi: 101, n: 4 });
});

test('size statistics count market orders, in the minute of their first fill; the price rows keep every fill', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 120_000);
  const fills = Array.from({ length: 30 }, (_, i) => fill(String(i), 85_000, 10_000, T0 + 1_000));
  recorder.ingest(fills);
  const order: MarketOrder = { instrumentId: 'v:BTC', tradeId: '0', side: 'buy', t: T0 + 1_000, price: 85_000, lo: 85_000, hi: 85_000, usd: 300_000, fills: 30 };
  recorder.countOrders([order]);
  const bar = recorder.query('v:BTC', T0, T0 + 60_000, 60_000, recorder.step('v:BTC')!).bars[0]!;
  assert.equal(bar.buyUsd, 300_000, 'every fill is volume at its price');
  assert.equal(bar.stats!.buyN, 1, 'one order');
  assert.deepEqual(bar.stats!.buy, [0, 0, 0, 0, 300_000, 0, 0, 0], 'in the $250K-$500K bucket, not thirty times in the smallest');
});

test('the database keeps the span and the fill count, and a database from before gains the columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-orders-'));
  const file = path.join(dir, 'p.sqlite');
  try {
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE prints (t INTEGER NOT NULL, inst TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, usd REAL NOT NULL)');
    old.prepare('INSERT INTO prints (t, inst, side, price, usd) VALUES (?, ?, ?, ?, ?)').run(T0, 'v:BTC', 'sell', 100, 30_000);
    old.close();
    const store = new SqlitePrintStore(file);
    store.save([{ t: T0 + 1, id: 'v:BTC', side: 'buy', price: 100.5, usd: 300_000, lo: 100, hi: 101, n: 30 }], 0);
    assert.deepEqual(store.query(T0, T0 + 10, 0, 10), [
      { t: T0, id: 'v:BTC', side: 'sell', price: 100, usd: 30_000 },
      { t: T0 + 1, id: 'v:BTC', side: 'buy', price: 100.5, usd: 300_000, lo: 100, hi: 101, n: 30 },
    ]);
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('connectors name the order of each fill where the exchange does', () => {
  const take = <C extends { onTrade: (t: TradeEvent) => void; onMessage(text: string): void }>(c: C, frames: unknown[]): TradeEvent[] => {
    const out: TradeEvent[] = []; c.onTrade = t => out.push(t); for (const f of frames) c.onMessage(JSON.stringify(f)); return out;
  };
  const hl = take(new HyperliquidConnector(), [{ channel: 'trades', data: [
    { coin: 'BTC', side: 'B', px: '83000', sz: '0.5', time: T0, hash: '0xfeed', tid: 1, users: ['0xa', '0xb'] },
    { coin: 'BTC', side: 'A', px: '83000', sz: '0.5', time: T0, hash: '0x0000000000000000', tid: 2, users: ['0xa', '0xb'] },
  ] }]);
  assert.deepEqual(hl.map(t => t.order), ['0xfeed', undefined], 'an all-zero hash names no order');
  const cb = take(new CoinbaseConnector(), [{ type: 'match', trade_id: 9, maker_order_id: 'm1', taker_order_id: 't1', side: 'sell', size: '0.1', price: '83000', time: new Date(T0).toISOString() }]);
  assert.deepEqual(cb.map(t => [t.side, t.order]), [['buy', 't1']], 'the taker order id; the match side is the maker\'s');
  const by = take(new BybitConnector(), [{ topic: 'publicTrade.BTCUSDT', data: [{ T: T0, S: 'Sell', v: '0.2', p: '83000', i: 'x1', seq: 123 }, { T: T0, S: 'Sell', v: '0.2', p: '83000', i: 'x2' }] }]);
  assert.deepEqual(by.map(t => t.order), ['123', undefined]);
});

test('the bubble box says what an order of several fills did', () => {
  assert.deepEqual(printPriceLines({ t: T0, id: 'v:BTC', side: 'buy', price: 100, usd: 30_000 }).map(l => l.label), ['Price']);
  const walked = printPriceLines({ t: T0, id: 'v:BTC', side: 'buy', price: 100.4, usd: 300_000, lo: 100, hi: 101, n: 12 });
  assert.deepEqual(walked.map(l => l.label), ['Average price', 'Fills', 'Prices reached']);
  assert.equal(walked[1]!.text, '12');
  const flat = printPriceLines({ t: T0, id: 'v:BTC', side: 'buy', price: 100, usd: 300_000, lo: 100, hi: 100, n: 5 });
  assert.deepEqual(flat.map(l => l.label), ['Average price', 'Fills'], 'no range when every fill was at one price');
});
