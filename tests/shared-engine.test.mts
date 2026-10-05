import test from 'node:test';
import assert from 'node:assert/strict';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine, packColumns, type EngineTick, type VenueStatus } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import type { ValuedBook } from '../src/shared/levels.ts';
import type { Print } from '../src/shared/prints.ts';
import { SAMPLE_MS } from '../src/shared/recorder.ts';

/** A connector with no socket: the test says when it is live and what its book holds. */
class Fake extends BookConnector {
  readonly name: string; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(readonly id: string) { super(); this.name = id; }
  override start(): void { this.state = 'connecting'; }
  override stop(): void { this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage(text: string) {
    const m = JSON.parse(text) as { bids: [number, number][]; asks: [number, number][] };
    this.replace(this.bids, m.bids); this.replace(this.asks, m.asks); this.touch();
  }
  book(bid: number, ask: number, size = 1) { this.onMessage(JSON.stringify({ bids: [[bid, size]], asks: [[ask, size]] })); }
  trade(t: Partial<TradeEvent> & { tradeId: string }) {
    const price = t.price ?? 100, amount = t.amount ?? 1;
    this.onTrade({ instrumentId: this.instrumentId, side: 'buy', price, amount, notionalUsd: price * amount, t: Date.now(), ...t });
  }
}

function setup(ids = ['binance', 'bybit'], options: Partial<ConstructorParameters<typeof Engine>[0]> = {}) {
  const fakes = new Map<string, Fake>();
  const venues: BrowserVenue[] = ids.map(id => ({ id, name: id, kind: 'perp', recommended: true, probe: { url: `https://${id}.example/ping` }, make: () => { const book = new Fake(id); fakes.set(id, book); return { book, feeds: [] }; } }));
  const engine = new Engine({ venues, ping: async () => true, get: async () => { throw new Error('offline'); }, ...options });
  return { engine, fakes, venues };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('select starts the wanted venues, stops the others and lists every venue with its state', () => {
  const { engine, fakes } = setup();
  assert.deepEqual(engine.venueStatus().map(v => v.state), ['off', 'off']);
  engine.select(['binance']);
  assert.deepEqual(engine.selected, ['binance']);
  assert.equal(engine.venueStatus()[0]!.state, 'connecting');
  fakes.get('binance')!.book(100, 101);
  assert.equal(engine.venueStatus()[0]!.state, 'live');
  engine.select(['bybit']);
  assert.equal(fakes.get('binance')!.state, 'stopped');
  assert.deepEqual(engine.venueStatus().map(v => [v.id, v.selected]), [['binance', false], ['bybit', true]]);
  engine.select(['nowhere']);
  assert.deepEqual(engine.selected, []);
});

test('levels are sent when a book changes and not when nothing did', () => {
  const { engine, fakes } = setup();
  const sent: ValuedBook[][] = [];
  engine.onLevels = books => sent.push(books);
  engine.select(['binance', 'bybit']);
  fakes.get('binance')!.book(100, 101);
  engine.step();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.length, 1);
  engine.step();
  assert.equal(sent.length, 1, 'an unchanged book is not sent again');
  fakes.get('bybit')!.book(100.5, 101.5);
  engine.step();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.map(b => b.instrumentId), ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  fakes.get('binance')!.book(100.2, 101);
  engine.step();
  assert.equal(sent.length, 3);
});

test('a venue that is live but gives no usable book says so after a while, and recovers', () => {
  let skew = 0;
  const { engine, fakes } = setup(['binance'], { now: () => Date.now() + skew });
  const sent: ValuedBook[][] = [];
  engine.onLevels = books => sent.push(books);
  engine.select(['binance']);
  const book = fakes.get('binance')!;
  // A bid above the ask: a feed fault, not a market. The connector withholds the book.
  book.onMessage(JSON.stringify({ bids: [[105, 1], [100, 1]], asks: [[101, 1], [102, 1]] }));
  engine.step();
  assert.deepEqual(sent.at(-1) ?? [], []);
  assert.equal(engine.venueStatus()[0]!.state, 'live');
  assert.equal(engine.venueStatus()[0]!.detail, '', 'a moment of nothing is not reported');
  skew = 11_000; engine.step();
  assert.match(engine.venueStatus()[0]!.detail, /no usable book/);
  book.book(100, 101);
  engine.step();
  assert.equal(sent.at(-1)!.length, 1);
  assert.equal(engine.venueStatus()[0]!.detail, '');
});

test('the reference price is the first live venue in the preferred order, and every live instrument has its own price', () => {
  const { engine, fakes } = setup(['binance', 'bybit']);
  const ticks: EngineTick[] = [];
  engine.onTick = tick => ticks.push(tick);
  engine.select(['binance', 'bybit']);
  fakes.get('bybit')!.book(200, 202);
  engine.step();
  assert.equal(ticks.at(-1)!.instrumentId, 'bybit:BTCUSDT', 'the preferred venue is not live, so the next one stands in');
  assert.equal(ticks.at(-1)!.price, 201);
  fakes.get('binance')!.book(100, 102);
  engine.step();
  assert.equal(ticks.at(-1)!.instrumentId, 'binance:BTCUSDT');
  assert.deepEqual(ticks.at(-1)!.prices, { 'binance:BTCUSDT': 101, 'bybit:BTCUSDT': 201 });
  fakes.get('binance')!.trade({ tradeId: '1', price: 100.5 });
  engine.step();
  assert.equal(ticks.at(-1)!.prices['binance:BTCUSDT'], 100.5, 'a fresh trade is the price');
  const n = ticks.length;
  engine.step();
  assert.equal(ticks.length, n, 'an unchanged tick is not sent again');
});

test('trades build the live candle, the footprint and the large-trade list', () => {
  const { engine, fakes } = setup(['binance']);
  const ticks: EngineTick[] = [], prints: Print[] = [];
  engine.onTick = tick => ticks.push(tick); engine.onPrints = fresh => prints.push(...fresh);
  engine.select(['binance']);
  const book = fakes.get('binance')!;
  book.book(100, 101);
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  book.trade({ tradeId: 'a', price: 100, amount: 2, t: minute + 1000 });
  book.trade({ tradeId: 'b', price: 103, amount: 1, t: minute + 2000, side: 'sell' });
  book.trade({ tradeId: 'c', price: 99, amount: 1, t: minute + 3000 });
  book.trade({ tradeId: 'big', price: 100, amount: 400, t: minute + 4000 }); // 40,000 USD
  book.trade({ tradeId: 'a', price: 100, amount: 2, t: minute + 1000 }); // a replay
  engine.step();
  assert.deepEqual(ticks.at(-1)!.candles['binance:BTCUSDT'], [minute, 100, 103, 99, 100, 404]);
  assert.deepEqual(prints.map(p => [p.id, p.side, p.usd]), [['binance:BTCUSDT', 'buy', 40_000]]);
  const answer = engine.footprint('binance:BTCUSDT', 60_000, minute, minute + 60_000, 1);
  assert.equal(answer.bars.length, 1);
  assert.ok(Math.abs(answer.bars[0]!.buyUsd - (200 + 99 + 40_000)) < 1e-6, 'the replayed trade counted once');
  assert.equal(engine.prints(minute, minute + 60_000).length, 1);
});

test('a candle is not rewound by an older trade, and a new minute starts a new candle', () => {
  const { engine, fakes } = setup(['binance']);
  engine.select(['binance']);
  const book = fakes.get('binance')!, ticks: EngineTick[] = [];
  engine.onTick = tick => ticks.push(tick);
  book.book(100, 101);
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  book.trade({ tradeId: '1', price: 100, t: minute + 5000 });
  book.trade({ tradeId: '0', price: 50, t: minute - 5000 });
  book.trade({ tradeId: '2', price: 110, t: minute + 70_000 });
  engine.step();
  assert.deepEqual(ticks.at(-1)!.candles['binance:BTCUSDT']!.slice(0, 5), [minute + 60_000, 110, 110, 110, 110]);
});

test('sampling the books records minute columns the page can read back as typed arrays', () => {
  const { engine, fakes } = setup(['binance']);
  engine.select(['binance']);
  fakes.get('binance')!.book(100, 101, 50);
  const t0 = Math.floor(Date.now() / 60_000) * 60_000;
  engine.step(t0 + 1000);
  engine.step(t0 + 1000 + SAMPLE_MS);
  const boot = engine.bootstrap();
  assert.ok(boot.steps['binance:BTCUSDT']! > 0);
  assert.equal(boot.recorded['binance:BTCUSDT']!.first, t0);
  const frame = engine.columns(['binance:BTCUSDT', 'unknown'], t0, t0 + 120_000, 60_000);
  const set = frame.instruments[0]!;
  assert.equal(set.id, 'binance:BTCUSDT');
  assert.equal(set.times.length, 1);
  assert.ok(set.bins instanceof Int32Array && set.bid instanceof Float32Array && set.ask instanceof Float32Array);
  assert.equal(set.bins.length, set.counts[0]);
  assert.deepEqual(frame.instruments[1]!.times, []);
});

test('columns are packed flat, one run of bins per column', () => {
  const [set] = packColumns([{ instrumentId: 'x', step: 2, columns: [
    { t: 0, n: 3, bins: Int32Array.of(1, 2), bid: Float32Array.of(5, 6), ask: Float32Array.of(0, 0) },
    { t: 60_000, n: 2, bins: Int32Array.of(7), bid: Float32Array.of(9), ask: Float32Array.of(1) },
  ] }]);
  assert.deepEqual([...set!.bins], [1, 2, 7]);
  assert.deepEqual(set!.counts, [2, 1]);
  assert.deepEqual(set!.samples, [3, 2]);
  assert.deepEqual([...set!.bid], [5, 6, 9]);
});

test('bootstrap lists the running venues as markets and says which have open interest', () => {
  const { engine, fakes } = setup(['binance', 'bybit', 'hyperliquid']);
  engine.select(['hyperliquid', 'bybit', 'binance']);
  fakes.get('bybit')!.book(100, 101);
  engine.step();
  const boot = engine.bootstrap();
  assert.deepEqual(boot.markets.map(m => m.instrumentId), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'hyperliquid:BTCUSDT']);
  assert.deepEqual(boot.oiReferences, ['binance:BTCUSDT', 'hyperliquid:BTCUSDT'], 'Binance first, then Hyperliquid, in that order whatever the selection order');
  assert.equal(boot.markInstrumentId, 'bybit:BTCUSDT');
  assert.equal(boot.markPrice, 100.5);
});

test('a venue that never connects, keeps failing and does not answer a REST request while others work is reported as unavailable here', async () => {
  const { engine, fakes } = setup(['binance', 'bybit', 'okx'], { ping: async url => !url.includes('binance') });
  engine.select(['binance', 'bybit', 'okx']);
  fakes.get('bybit')!.book(100, 101); fakes.get('okx')!.book(100, 101);
  const blocked = fakes.get('binance')!;
  blocked.failures = 3; blocked.lastFailure = 'socket closed';
  engine.step(); await settle(); engine.step();
  const byId = new Map(engine.venueStatus().map(v => [v.id, v] as const));
  assert.equal(byId.get('binance')!.state, 'blocked');
  assert.match(byId.get('binance')!.detail, /unavailable from your location/);
  assert.equal(byId.get('bybit')!.state, 'live');
});

test('failures that are not backed by a failed REST request, or that happen while nothing else works, are not called a block', async () => {
  // The REST request works: the venue is up, so the socket trouble is something else.
  let { engine, fakes } = setup(['binance', 'bybit']);
  engine.select(['binance', 'bybit']);
  fakes.get('bybit')!.book(100, 101);
  fakes.get('binance')!.failures = 3; fakes.get('binance')!.lastFailure = 'socket closed';
  engine.step(); await settle(); engine.step();
  assert.deepEqual(engine.venueStatus().map(v => v.state), ['error', 'live']);
  assert.equal(engine.venueStatus()[0]!.detail, 'socket closed');
  // Everything fails, including the REST request: the network is down, not one country.
  ({ engine, fakes } = setup(['binance', 'bybit'], { ping: async () => false }));
  engine.select(['binance', 'bybit']);
  for (const f of fakes.values()) { f.failures = 5; f.lastFailure = 'socket error'; }
  engine.step(); await settle(); engine.step();
  assert.deepEqual(engine.venueStatus().map(v => v.state), ['error', 'error']);
  // A venue that did connect once is never called blocked.
  ({ engine, fakes } = setup(['binance', 'bybit', 'okx'], { ping: async () => false }));
  engine.select(['binance', 'bybit', 'okx']);
  fakes.get('bybit')!.book(1, 2); fakes.get('okx')!.book(1, 2);
  const once = fakes.get('binance')!; once.book(1, 2); once.state = 'error'; once.failures = 4;
  engine.step(); await settle(); engine.step();
  assert.equal(engine.venueStatus()[0]!.state, 'error');
});

test('status changes are announced once and not repeated', () => {
  const { engine, fakes } = setup(['binance']);
  const seen: VenueStatus[][] = [];
  engine.onStatus = status => seen.push(status);
  engine.step(); engine.select(['binance']); engine.step(); engine.step();
  fakes.get('binance')!.book(1, 2); engine.step(); engine.step();
  assert.deepEqual(seen.map(s => s[0]!.state), ['off', 'connecting', 'live']);
});

test('candles come from the venue, and a venue that cannot be reached gives none', async () => {
  const minute = 60_000, t0 = Math.floor(Date.now() / minute) * minute - 10 * minute;
  const rows = Array.from({ length: 11 }, (_, k) => [t0 + k * minute, '10', '12', '9', '11', '1']);
  const { engine } = setup(['binance'], { get: async () => rows });
  const candles = await engine.candles('binance:BTCUSDT', minute, t0, t0 + 10 * minute);
  assert.equal(candles.length, 11);
  assert.deepEqual(await setup().engine.candles('binance:BTCUSDT', minute, t0, t0 + 10 * minute), []);
});

test('open interest joins the venue history with the readings taken while the page was open', async () => {
  const hour = 3_600_000, base = Math.floor(Date.now() / hour) * hour;
  const get = async (url: string) => url.includes('openInterestHist') ? [{ timestamp: base - hour, sumOpenInterest: '100' }] : { openInterest: '105' };
  const { engine } = setup(['binance'], { get });
  engine.select(['binance']);
  engine.step(); await settle();
  const bars = await engine.oi('binance:BTCUSDT', hour, base - 2 * hour, base + hour);
  assert.equal(bars.at(-1)![4], 105, 'the live reading is the newest close');
  assert.ok(bars.some(b => b[4] === 100));
});

test('stopping the engine stops every connector', () => {
  const { engine, fakes } = setup(['binance', 'bybit']);
  engine.select(['binance', 'bybit']);
  engine.stop();
  assert.ok([...fakes.values()].every(f => f.state === 'stopped'));
  assert.deepEqual(engine.selected, []);
});

test('an empty first pass does not delay the first sample, and a live venue not yet sampled is reported as recording from this minute', () => {
  const t = Date.now(), minute = Math.floor(t / 60_000) * 60_000;
  const { engine, fakes } = setup(['binance'], { now: () => t });
  engine.select(['binance']);
  engine.step();
  assert.deepEqual(engine.bootstrap().recorded, {}, 'nothing is live, so nothing is claimed');
  fakes.get('binance')!.book(100, 101);
  assert.deepEqual(engine.bootstrap().recorded, { 'binance:BTCUSDT': { first: minute, last: minute } });
  engine.step();
  assert.equal(engine.recorder.coverage()['binance:BTCUSDT']?.first, minute, 'the very next pass recorded it');
});
