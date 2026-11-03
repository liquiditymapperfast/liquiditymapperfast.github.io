import test from 'node:test';
import assert from 'node:assert/strict';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import type { FootprintMinuteRow, FootprintStore } from '../src/shared/footprint.ts';
import type { FlowMinuteRow, FlowStore } from '../src/shared/flow.ts';
import type { Print } from '../src/shared/prints.ts';

// A page starts its engine on the venues' sockets at once and hands it the recordings once they are read (`deferred`, then `attach`): what
// came meanwhile is counted once, a trade the recordings hold is not counted again, and nothing is handed on as new a second time.

const MIN = 60_000, ID = 'binance:BTCUSDT';

/** A connector with no socket: the test says what it trades. */
class Fake extends BookConnector {
  readonly name: string; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(readonly id: string) { super(); this.name = id; }
  override start(): void { this.state = 'connecting'; }
  override stop(): void { this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage() {}
  trade(t: Partial<TradeEvent> & { tradeId: string; t: number }) { const price = t.price ?? 100, amount = t.amount ?? 1; this.onTrade({ instrumentId: this.instrumentId, side: 'buy', price, amount, notionalUsd: price * amount, ...t }); }
}

/** Stores kept in memory, written and read back the way the browser's are. */
function memoryStores(): { footprint: FootprintStore; flow: FlowStore } {
  const fp = new Map<string, FootprintMinuteRow>(), fl = new Map<string, FlowMinuteRow>();
  return {
    footprint: { load: since => [...fp.values()].filter(r => r.t >= since), save: rows => { for (const r of rows) fp.set(`${r.inst}|${r.t}`, structuredClone(r)); }, close() {} },
    flow: { load: since => [...fl.values()].filter(r => r.t >= since), save: rows => { for (const r of rows) fl.set(`${r.inst}|${r.t}`, structuredClone(r)); }, close() {} },
  };
}
const noStores = { columns: null, footprint: null, prints: null, flow: null, absorption: null, coverage: null, liquidations: null, oi: null };

function open(clock: { now: number }, options: { stores?: ReturnType<typeof memoryStores>; deferred?: boolean }) {
  let venue: Fake | null = null;
  const venues: BrowserVenue[] = [{ id: 'binance', name: 'binance', kind: 'perp', recommended: true, listed: true, probe: { url: 'https://binance.example/ping' }, make: () => { venue = new Fake('binance'); return { book: venue, feeds: [] }; } }];
  const engine = new Engine({ venues, now: () => clock.now, ping: async () => true, get: async () => { throw new Error('offline'); }, footprint: options.stores?.footprint ?? null, flow: options.stores?.flow ?? null, deferred: options.deferred ?? false });
  const fresh: Print[] = [];
  engine.onPrints = items => fresh.push(...items);
  engine.select(['binance']);
  return { engine, venue: venue! as Fake, fresh };
}
const profile = (engine: Engine, from: number, to: number) => engine.footprints.profile([ID], from, to, 1).instruments[0]?.rows.map(([price, buy, sell]) => [price, buy, sell]) ?? [];
const flowTotals = (engine: Engine, from: number, to: number) => { const f = engine.flows.frame([ID], from, to).instruments[0]; return f ? [f.buy.reduce((a, x) => a + x, 0), f.sell.reduce((a, x) => a + x, 0)] : [0, 0]; };

test('the recordings handed over after the start: what came meanwhile counts once, what they hold is not counted again', () => {
  const clock = { now: Date.UTC(2026, 10, 3, 12, 0, 30) }, stores = memoryStores(), old = clock.now - 20_000;
  const from = Math.floor(old / MIN) * MIN - MIN, to = clock.now + 2 * MIN;
  // The visit before: a burst of two fills (one market order), written when the page went away.
  const before = open(clock, { stores });
  before.venue.trade({ tradeId: 'b1', side: 'sell', price: 100, amount: 300, t: old }); before.venue.trade({ tradeId: 'b2', side: 'sell', price: 100, amount: 300, t: old + 3 });
  before.engine.stop();

  // This visit: the engine runs before its recordings are read. The venue sends the burst again (from before the engine started: held back),
  // and a large new order trades while the recordings are read.
  const page = open(clock, { deferred: true });
  assert.equal(page.engine.waiting, true);
  page.venue.trade({ tradeId: 'b1', side: 'sell', price: 100, amount: 300, t: old }); page.venue.trade({ tradeId: 'b2', side: 'sell', price: 100, amount: 300, t: old + 3 });
  page.venue.trade({ tradeId: 'n1', side: 'buy', price: 101, amount: 1_000, t: clock.now });
  clock.now += 1_000; page.engine.step(clock.now);
  assert.deepEqual(profile(page.engine, from, to), [[101, 101_000, 0]], 'live, before the recordings: the new order alone (the burst waits for them)');
  assert.deepEqual(page.fresh.map(p => [p.side, p.usd]), [['buy', 101_000]], 'the new order is shown as it comes');
  assert.deepEqual(flowTotals(page.engine, from, to), [101_000, 0]);

  page.engine.attach({ ...noStores, ...stores });
  assert.equal(page.engine.waiting, false);
  assert.deepEqual(profile(page.engine, from, to), [[100, 0, 60_000], [101, 101_000, 0]], 'the burst once (from the recordings), the new order once (played in)');
  assert.deepEqual(flowTotals(page.engine, from, to), [101_000, 60_000]);
  assert.deepEqual(page.engine.prints(from, to).map(p => [p.side, p.usd]), [['buy', 101_000]], 'the order taken live is among the recorded prints');
  // A trade after the hand-over counts as ever, and nothing found by the replay is handed on as new again.
  page.venue.trade({ tradeId: 'n2', side: 'sell', price: 99, amount: 500, t: clock.now });
  clock.now += 1_000; page.engine.step(clock.now);
  assert.deepEqual(profile(page.engine, from, to), [[99, 0, 49_500], [100, 0, 60_000], [101, 101_000, 0]]);
  assert.deepEqual(page.fresh.map(p => [p.side, p.usd]), [['buy', 101_000], ['sell', 49_500]], 'each order is shown as new once');
  page.engine.attach({ ...noStores, ...stores });
  assert.deepEqual(profile(page.engine, from, to), [[99, 0, 49_500], [100, 0, 60_000], [101, 101_000, 0]], 'a second hand-over changes nothing');
  page.engine.stop();
});

test('no recordings come: the trades held back are taken all the same, as a page without recordings takes them', () => {
  const clock = { now: Date.UTC(2026, 10, 3, 12, 0, 30) }, old = clock.now - 20_000;
  const from = Math.floor(old / MIN) * MIN - MIN, to = clock.now + 2 * MIN;
  const page = open(clock, { deferred: true });
  page.venue.trade({ tradeId: 'b1', side: 'sell', price: 100, amount: 300, t: old });
  page.venue.trade({ tradeId: 'n1', side: 'buy', price: 101, amount: 100, t: clock.now });
  clock.now += 1_000; page.engine.step(clock.now);
  assert.deepEqual(profile(page.engine, from, to), [[101, 10_100, 0]]);
  page.engine.attach(null);
  assert.deepEqual(profile(page.engine, from, to), [[100, 0, 30_000], [101, 10_100, 0]]);
  assert.deepEqual(page.fresh, [], 'an order played in after the fact is not shown as new');
  page.engine.stop();
});

test('an engine started with its recordings is not waiting, and a hand-over to it changes nothing', () => {
  const clock = { now: Date.UTC(2026, 10, 3, 12, 0, 30) }, stores = memoryStores();
  const page = open(clock, { stores });
  page.venue.trade({ tradeId: 'n1', side: 'buy', price: 101, amount: 100, t: clock.now });
  assert.equal(page.engine.waiting, false);
  const recorder = page.engine.footprints;
  page.engine.attach({ ...noStores, ...memoryStores() });
  assert.equal(page.engine.footprints, recorder);
  page.engine.stop();
});
