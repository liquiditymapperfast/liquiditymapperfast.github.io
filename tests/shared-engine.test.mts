import test from 'node:test';
import assert from 'node:assert/strict';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine, packColumns, type EngineTick, type OiReading, type OiStore, type VenueStatus } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import type { ValuedBook } from '../src/shared/levels.ts';
import type { Print } from '../src/shared/prints.ts';
import { SAMPLE_MS } from '../src/shared/recorder.ts';
import type { FlowUpdate } from '../src/shared/flow.ts';

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
  const venues: BrowserVenue[] = ids.map(id => ({ id, name: id, kind: 'perp', recommended: true, listed: true, probe: { url: `https://${id}.example/ping` }, make: () => { const book = new Fake(id); fakes.set(id, book); return { book, feeds: [] }; } }));
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

test('levels carry the step each book was merged on: the recorder\'s for the instrument, else the grid for its mid', () => {
  const { engine, fakes } = setup(['binance', 'bybit']);
  const sent: ValuedBook[][] = [];
  engine.onLevels = books => sent.push(books);
  engine.recorder.steps.set('binance:BTCUSDT', 0.5);
  engine.select(['binance', 'bybit']);
  fakes.get('binance')!.book(100, 101);
  fakes.get('bybit')!.book(100, 101);
  engine.step();
  const steps = Object.fromEntries(sent.at(-1)!.map(b => [b.instrumentId, b.step]));
  assert.deepEqual(steps, { 'binance:BTCUSDT': 0.5, 'bybit:BTCUSDT': 0.02 }, 'the recorder\'s step where it has one, gridStepFor(100.5) where it has not');
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
  let later = 0;
  const { engine, fakes } = setup(['binance'], { now: () => Date.now() + later });
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
  // The last market order is complete once nothing has joined it for a moment (orders.ts): the print comes on the pass after that.
  later = 200;
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
  assert.deepEqual(boot.oiReferences, ['binance:BTCUSDT', 'bybit:BTCUSDT', 'hyperliquid:BTCUSDT'], 'in the order of the sampled venues (Binance first) whatever the selection order');
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

test('a page never asks OKX for its open-interest history (it sends no CORS header), and asks Bybit for it', async () => {
  const hour = 3_600_000, base = Math.floor(Date.now() / hour) * hour, asked: string[] = [];
  const get = async (url: string) => { asked.push(url); return url.includes('rubik') ? { code: '0', data: [] } : { retCode: 0, result: { list: [] } }; };
  const { engine } = setup(['okx', 'bybit'], { get });
  await engine.oi('okx:BTC-USDT-SWAP', hour, base - 2 * hour, base + hour);
  assert.ok(!asked.some(u => u.includes('open-interest-history')), asked.join(' '));
  await engine.oi('bybit:BTCUSDT', hour, base - 2 * hour, base + hour);
  assert.ok(asked.some(u => u.includes('api.bybit.com/v5/market/open-interest')), 'the check reaches a venue a page can read');
});

test('open interest pushed on a venue socket lands in its own minute and the newest push moves that minute in place', async () => {
  const minute = 60_000, t0 = Math.floor(Date.now() / minute) * minute - 10 * minute;
  const { engine, fakes } = setup(['bybit'], { now: () => t0 + 4 * minute });
  engine.select(['bybit']);
  const book = fakes.get('bybit')!;
  book.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 3 * minute + 7_000, base: 50_000 });
  book.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 3 * minute + 21_000, base: 50_500 });
  engine.step(); await settle();
  const bars = await engine.oi('bybit:BTCUSDT', minute, t0, t0 + 5 * minute);
  assert.equal(bars.filter(b => b[0] === t0 + 3 * minute).length, 1, 'one reading a minute, however many pushes');
  assert.equal(bars.at(-1)![4], 50_500, 'the newest push is the minute\'s close');
});

test('a venue with a socket OI feed asks REST only once the stream has brought nothing for a minute, and then once a minute', async () => {
  let now = Date.now(), calls = 0;
  const get = async (url: string) => {
    if (url.includes('api.bybit.com/v5/market/tickers')) { calls++; return { result: { list: [{ openInterest: '200', singleOpenInterest: '100' }] } }; }
    throw new Error('offline');
  };
  const { engine, fakes } = setup(['bybit'], { now: () => now, get });
  engine.select(['bybit']);
  fakes.get('bybit')!.onOi({ instrumentId: 'bybit:BTCUSDT', t: now, base: 50_000 });
  engine.step(); await settle();
  assert.equal(calls, 0, 'the socket reading keeps the REST fallback quiet');
  now += 59_000; engine.step(); await settle();
  assert.equal(calls, 0, 'a quiet socket within the minute costs no request (open interest arrives only when it changes)');
  now += 2_000; engine.step(); await settle();
  assert.equal(calls, 1, 'after a silent minute the fallback asks');
  now += 30_000; engine.step(); await settle();
  assert.equal(calls, 1, "the fallback keeps the minute's cadence it always had");
  now += 30_000; engine.step(); await settle();
  assert.equal(calls, 2, 'a due pass asks');
});

test("an open-interest reading older than the venue's newest changes nothing, and the store keeps each minute's last reading", async () => {
  const minute = 60_000, t0 = Math.floor(Date.now() / minute) * minute - 10 * minute;
  const saved: OiReading[] = [], live: number[] = [];
  const oi: OiStore = { load: () => [], save: rows => { saved.push(...rows); }, close() {} };
  const { engine, fakes } = setup(['bybit'], { now: () => t0 + 4 * minute, oi });
  engine.onOiLive = (_id, reading) => live.push(reading.base);
  engine.select(['bybit']);
  const book = fakes.get('bybit')!;
  book.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 3 * minute + 50_000, base: 110 });
  book.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 3 * minute + 10_000, base: 90 });
  book.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 2 * minute + 30_000, base: 80 });
  engine.step(); await settle();
  const bars = await engine.oi('bybit:BTCUSDT', minute, t0, t0 + 5 * minute);
  assert.equal(bars.at(-1)![4], 110, "the delayed readings did not take the newest one's place");
  assert.equal(bars.filter(b => b[0] === t0 + 2 * minute).length, 0, 'nor open an earlier minute');
  assert.deepEqual(live, [110], 'only the reading taken is handed on');
  book.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 3 * minute + 55_000, base: 150 });
  const kept = new Map(saved.map(row => [`${row.venue}|${row.t}`, row.base]));
  assert.equal(kept.get(`bybit|${t0 + 3 * minute}`), 150, "a reload reads the minute's last value, not its first");
});

test('Binance open interest, which has no socket, is polled every five seconds', async () => {
  let now = Date.now(), calls = 0;
  const get = async (url: string) => {
    if (url.includes('/fapi/v1/openInterest')) { calls++; return { openInterest: '105' }; }
    throw new Error('offline');
  };
  const { engine } = setup(['binance'], { now: () => now, get });
  engine.select(['binance']);
  engine.step(); await settle();
  assert.equal(calls, 1, 'the first pass asks');
  now += 4_000; engine.step(); await settle();
  assert.equal(calls, 1, 'not again within five seconds');
  now += 1_000; engine.step(); await settle();
  assert.equal(calls, 2, 'every five seconds');
});

test('every reading is handed to onOiLive the moment it lands, from the socket and from the REST poll', async () => {
  const socketReadings: { instrumentId: string; base: number }[] = [], restReadings: { instrumentId: string; base: number }[] = [];
  const minute = 60_000, t0 = Math.floor(Date.now() / minute) * minute;
  const bybit = setup(['bybit'], { now: () => t0 });
  bybit.engine.onOiLive = (instrumentId, reading) => socketReadings.push({ instrumentId, base: reading.base });
  bybit.engine.select(['bybit']);
  bybit.fakes.get('bybit')!.onOi({ instrumentId: 'bybit:BTCUSDT', t: t0 + 7_000, base: 50_000 });
  await settle();
  assert.deepEqual(socketReadings, [{ instrumentId: 'bybit:BTCUSDT', base: 50_000 }], 'the socket reading is pushed with its market');
  bybit.engine.stop();
  let now = t0;
  const binance = setup(['binance'], { now: () => now, get: async url => url.includes('/fapi/v1/openInterest') ? { openInterest: '105' } : null });
  binance.engine.onOiLive = (instrumentId, reading) => restReadings.push({ instrumentId, base: reading.base });
  binance.engine.select(['binance']);
  binance.engine.step(); await settle();
  assert.deepEqual(restReadings, [{ instrumentId: 'binance:BTCUSDT', base: 105 }], 'the REST poll reading is pushed too');
  binance.engine.stop();
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

test('taker flow is recorded per second, announced about once a second, and answered as a frame', () => {
  let now = Date.now();
  const { engine, fakes } = setup(['binance'], { now: () => now });
  const announced: FlowUpdate[][] = [];
  engine.onFlow = items => announced.push(items);
  engine.select(['binance']);
  const fake = fakes.get('binance')!; fake.book(99, 101);
  fake.trade({ tradeId: 'a', side: 'buy', price: 100, amount: 10, t: now });
  fake.trade({ tradeId: 'b', side: 'sell', price: 100, amount: 4, t: now });
  fake.trade({ tradeId: 'a', side: 'buy', price: 100, amount: 10, t: now });          // a replay
  engine.step(now);
  assert.equal(announced.length, 1);
  const second = Math.floor(now / 1000) * 1000;
  assert.deepEqual(announced[0], [[fake.instrumentId, second, 1_000, 400, 100]], 'one entry: the totals of the second and its price, the replay not counted');
  engine.step(now + 300);
  assert.equal(announced.length, 1, 'nothing changed and a second has not passed');
  now += 1_500; fake.trade({ tradeId: 'c', side: 'buy', price: 100, amount: 1, t: now }); engine.step(now);
  assert.equal(announced.length, 2);
  const frame = engine.flow([fake.instrumentId], now - 60_000, now + 1_000);
  const series = frame.instruments[0]!;
  assert.equal(series.buy.reduce((a, b) => a + b, 0), 1_100); assert.equal(series.sell.reduce((a, b) => a + b, 0), 400);
});

test('fills that the exchange reports one by one print as one market order, and the size statistics count it once', () => {
  let later = 0;
  const { engine, fakes } = setup(['bybit'], { now: () => Date.now() + later });
  const prints: Print[] = [];
  engine.onPrints = fresh => prints.push(...fresh);
  engine.select(['bybit']);
  const book = fakes.get('bybit')!;
  book.book(100, 101);
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  // Twenty fills of $2,000 each (a Bybit market order that took twenty resting orders): no single fill is anywhere near the print floor.
  for (let i = 0; i < 20; i++) book.trade({ tradeId: `f${i}`, price: 100 + i * 0.05, amount: 20, t: minute + 1_000, order: 'seq-1' });
  engine.step();
  assert.equal(prints.length, 0, 'not printed while the order may still be filling');
  later = 200; engine.step();
  assert.equal(prints.length, 1);
  const total = Array.from({ length: 20 }, (_, i) => (100 + i * 0.05) * 20).reduce((x, y) => x + y, 0);
  assert.equal(prints[0]!.n, 20); assert.ok(Math.abs(prints[0]!.usd - total) < 1e-6, `${prints[0]!.usd} vs ${total}`);
  assert.equal(prints[0]!.lo, 100); assert.ok(Math.abs(prints[0]!.hi! - 100.95) < 1e-9);
  const stats = engine.footprint('bybit:BTCUSDT', 60_000, minute, minute + 60_000, 1).bars[0]!.stats!;
  assert.equal(stats.buyN, 1, 'one market order');
  assert.ok(Math.abs(stats.buy[1]! - total) < 1e-6, 'in the $25K-$50K bucket');
});

test("stored readings are read back as one row a minute, the newest by its own time whichever build wrote it, and an older reading after a reload changes nothing", async () => {
  const minute = 60_000, m = Math.floor(Date.now() / minute) * minute - 10 * minute;
  const close = async (rows: OiReading[], then?: (book: Fake) => void): Promise<number> => {
    const oi: OiStore = { load: () => rows, save() {}, close() {} };
    const { engine, fakes } = setup(['bybit'], { now: () => m + 5 * minute, oi });
    engine.select(['bybit']); then?.(fakes.get('bybit')!);
    const bars = await engine.oi('bybit:BTCUSDT', minute, m - minute, m + 2 * minute);
    engine.stop();
    return bars.find(b => b[0] === m)![4];
  };
  assert.equal(await close([{ venue: 'bybit', t: m, at: m + 10_000, base: 100 }, { venue: 'bybit', t: m + 30_000, base: 200 }]), 200, 'an older build’s reading taken later wins over this build’s earlier one');
  assert.equal(await close([{ venue: 'bybit', t: m, at: m + 50_000, base: 150 }, { venue: 'bybit', t: m + 30_000, base: 200 }]), 150, 'and loses to a later one');
  assert.equal(await close([{ venue: 'bybit', t: m + 50_000, base: 150 }], book => book.onOi({ instrumentId: 'bybit:BTCUSDT', t: m + 40_000, base: 100 })), 150, 'a reading older than one read back is not taken');
});

test('a stored Hyperliquid reading an older build wrote with its two-sided figure is read as one side; a marked one, and other venues\', as they are', async () => {
  const minute = 60_000, m = Math.floor(Date.now() / minute) * minute - 10 * minute;
  const closes = async (rows: OiReading[], id: string): Promise<(number | undefined)[]> => {
    const oi: OiStore = { load: () => rows, save() {}, close() {} };
    const { engine } = setup([], { now: () => m + 5 * minute, oi });
    const bars = await engine.oi(id, minute, m - minute, m + 3 * minute);
    engine.stop();
    return [m, m + minute].map(t => bars.find(b => b[0] === t)?.[4]);
  };
  assert.deepEqual(await closes([{ venue: 'hyperliquid', t: m, at: m + 5_000, base: 100 }, { venue: 'hyperliquid', t: m + minute, at: m + minute + 5_000, base: 50, sides: 1 }], 'hyperliquid:BTC-PERP'), [50, 50], 'an older build\'s 100 is 50; a marked 50 stays 50');
  const usd = async (rows: OiReading[]): Promise<number | undefined> => {
    const { engine } = setup([], { now: () => m + 5 * minute, oi: { load: () => rows, save() {}, close() {} } });
    const bars = await engine.oi('hyperliquid:BTC-PERP', minute, m - minute, m + 3 * minute, true);
    engine.stop();
    return bars.find(b => b[0] === m)?.[4];
  };
  assert.equal(await usd([{ venue: 'hyperliquid', t: m, at: m + 5_000, base: 100, quote: 8_000_000 }]), 4_000_000, 'its USD too');
  assert.equal((await closes([{ venue: 'bybit', t: m, at: m + 5_000, base: 100 }], 'bybit:BTCUSDT'))[0], 100, 'every other venue\'s rows were one side already');
});

test('the page\'s own Hyperliquid reading is one side of its two-sided figure, handed on and stored marked', async () => {
  const minute = 60_000, now = Math.floor(Date.now() / minute) * minute + 30_000;
  const saved: OiReading[] = [], live: number[] = [];
  const oi: OiStore = { load: () => [], save: rows => { saved.push(...rows); }, close() {} };
  const get = async (url: string, init?: { body?: string }): Promise<unknown> => {
    if (url.includes('api.hyperliquid.xyz/info') && init?.body?.includes('metaAndAssetCtxs')) return [{ universe: [{ name: 'BTC' }] }, [{ openInterest: '100', markPx: '80000' }]];
    throw new Error('offline');
  };
  const { engine } = setup(['hyperliquid'], { now: () => now, oi, get });
  engine.onOiLive = (_id, reading) => live.push(reading.base);
  engine.select(['hyperliquid']);
  engine.step(now);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(live, [50]);
  assert.deepEqual(saved.map(r => [r.venue, r.t, r.base, r.sides]), [['hyperliquid', now - 30_000, 50, 1]]);
  engine.stop();
});
