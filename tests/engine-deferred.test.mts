import test from 'node:test';
import assert from 'node:assert/strict';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import type { FootprintMinuteRow, FootprintStore } from '../src/shared/footprint.ts';
import type { FlowMinuteRow, FlowStore } from '../src/shared/flow.ts';
import type { Print } from '../src/shared/prints.ts';
import type { OiReading } from '../src/shared/engine.ts';
import { SAMPLE_MS, type Column, type ColumnStore } from '../src/shared/recorder.ts';
import { CONTIGUOUS_GAP_MS } from '../src/shared/columns.ts';
import { gridStepFor } from '../src/shared/grid.ts';

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
  oi(t: number, base: number) { this.onOi({ instrumentId: this.instrumentId, t, base }); }
  book(bid: number, ask: number, size = 1) { this.replace(this.bids, [[bid, size]]); this.replace(this.asks, [[ask, size]]); this.touch(); }
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
  const fresh: Print[] = [], tape: number[] = [];
  engine.onPrints = items => fresh.push(...items);
  engine.onTape = batch => tape.push(...batch.usd);
  engine.select(['binance']);
  return { engine, venue: venue! as Fake, fresh, tape };
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

/** A copy of the stores as they stand (each engine of a comparison writes its own). */
function copyStores(stores: ReturnType<typeof memoryStores>): ReturnType<typeof memoryStores> {
  const copy = memoryStores();
  copy.footprint.save([...stores.footprint.load(0)], 0); copy.flow.save([...stores.flow.load(0)], 0);
  return copy;
}

test('handed its recordings a minute late, an engine ends where one started with them ends: footprint, flow, prints and coverage', () => {
  const T = Date.UTC(2026, 10, 3, 12, 0, 20), stores = memoryStores();
  // The visit before: trades over the two minutes before this one, written when that page went away.
  const prior = { now: T - 150_000 }, before = open(prior, { stores });
  before.venue.state = 'live';
  for (let i = 0; i < 40; i++) {
    prior.now += 3_000;
    before.venue.trade({ tradeId: `p${i}`, side: i % 3 ? 'buy' : 'sell', price: 100 + (i % 5), amount: i % 7 === 0 ? 400 : 20, t: prior.now });
    before.engine.step(prior.now);
  }
  before.engine.stop();

  // Two engines from this visit's start, fed the same: one with the recordings from the start, one handed them at +60 s.
  const clockA = { now: T }, clockB = { now: T };
  const a = open(clockA, { stores: copyStores(stores) }), b = open(clockB, { deferred: true });
  a.venue.state = 'live'; b.venue.state = 'live';
  const late = copyStores(stores);
  const both = (fn: (page: ReturnType<typeof open>) => void): void => { fn(a); fn(b); };
  // The venue first sends again the last twenty trades of the visit before (it does on connecting), then new ones.
  both(page => { for (let i = 20; i < 40; i++) page.venue.trade({ tradeId: `p${i}`, side: i % 3 ? 'buy' : 'sell', price: 100 + (i % 5), amount: i % 7 === 0 ? 400 : 20, t: T - 150_000 + (i + 1) * 3_000 }); });
  for (let k = 0; k < 480; k++) {   // two minutes, a pass every 250 ms
    const now = T + (k + 1) * 250;
    if (k % 3 === 0) both(page => page.venue.trade({ tradeId: `n${k}`, side: k % 2 ? 'buy' : 'sell', price: 101 + (k % 4), amount: k % 11 === 0 ? 600 : 15, t: now - 40 }));
    if (k % 9 === 0) both(page => page.venue.trade({ tradeId: `n${k}b`, side: 'buy', price: 102, amount: 300, t: now - 40, order: `o${Math.floor(k / 18)}` }));
    clockA.now = now; clockB.now = now;
    a.engine.step(now); b.engine.step(now);
    if (k === 240) b.engine.attach({ ...noStores, ...late });
  }
  const from = T - 4 * MIN, to = T + 4 * MIN;
  assert.deepEqual(profile(b.engine, from, to), profile(a.engine, from, to), 'footprint');
  const flowA = a.engine.flows.frame([ID], from, to).instruments[0]!, flowB = b.engine.flows.frame([ID], from, to).instruments[0]!;
  assert.deepEqual([...flowB.buy], [...flowA.buy], 'flow, second by second (buys)'); assert.deepEqual([...flowB.sell], [...flowA.sell], 'flow (sells)');
  assert.deepEqual(b.engine.prints(from, to), a.engine.prints(from, to), 'large trades');
  assert.deepEqual(b.engine.tradeCoverage.covered(ID, from, to), a.engine.tradeCoverage.covered(ID, from, to), 'coverage');
  assert.ok(a.engine.prints(from, to).length > 3, 'the comparison has large trades in it');
  a.engine.stop(); b.engine.stop();
});

test('an order completed before the hand-over is not announced again after it, however late in the pass it was taken', () => {
  const T = Date.UTC(2026, 10, 3, 12, 0, 20), from = T - MIN, to = T + MIN;
  // The pass begins 149 ms after the fill and the orders are taken at 154 ms (the books took a moment): complete by then.
  const late = { now: T }, a = open(late, { deferred: true });
  a.venue.trade({ tradeId: 'w1', side: 'buy', price: 101, amount: 1_000, t: T });
  late.now = T + 154; a.engine.step(T + 149);
  assert.equal(a.fresh.length, 1);
  a.engine.attach(null);
  late.now = T + 2_000; a.engine.step(late.now);
  assert.equal(a.fresh.length, 1, 'shown once');
  assert.equal(a.engine.prints(from, to).length, 1);
  // A flush (the page going away, or the worker told to write) takes every order, the open one too.
  const flushed = { now: T }, b = open(flushed, { deferred: true });
  b.venue.trade({ tradeId: 'w2', side: 'sell', price: 99, amount: 1_000, t: T });
  b.engine.flush(); flushed.now = T + 10; b.engine.step(flushed.now);
  assert.equal(b.fresh.length, 1);
  b.engine.attach(null);
  flushed.now = T + 2_000; b.engine.step(flushed.now);
  assert.equal(b.fresh.length, 1, 'shown once');
  a.engine.stop(); b.engine.stop();
});

test('open interest: of a minute read live and kept by another tab, the newer reading stays and the older is not written over it', async () => {
  const T = Date.UTC(2026, 10, 3, 12, 0, 40), minute = Math.floor(T / MIN) * MIN, clock = { now: T };
  const rows = new Map<string, OiReading>([[`binance|${minute}`, { venue: 'binance', t: minute, at: minute + 29_500, base: 200 }], [`binance|${minute - MIN}`, { venue: 'binance', t: minute - MIN, at: minute - 1_000, base: 150 }]]);
  const oi = { load: () => [...rows.values()], save: (list: OiReading[]) => { for (const r of list) rows.set(`${r.venue}|${r.t}`, { ...r }); }, close() {} };
  const page = open(clock, { deferred: true });
  page.venue.oi(minute + 29_000, 100);   // read live: older than the one another tab kept for this minute
  page.venue.oi(minute + 35_000 - MIN * 0, 300);   // and a later one, newer than any kept
  page.engine.attach({ ...noStores, oi });
  assert.equal(rows.get(`binance|${minute}`)!.base, 300, 'the newest reading of the minute is the one kept');
  const page2 = open(clock, { deferred: true }), rows2 = new Map(rows), oi2 = { ...oi, load: () => [...rows2.values()], save: (list: OiReading[]) => { for (const r of list) rows2.set(`${r.venue}|${r.t}`, { ...r }); } };
  rows2.set(`binance|${minute}`, { venue: 'binance', t: minute, at: minute + 40_000, base: 500 });
  page2.venue.oi(minute + 29_000, 100);
  page2.engine.attach({ ...noStores, oi: oi2 });
  assert.equal(rows2.get(`binance|${minute}`)!.base, 500, 'an older live reading is not written over a newer kept one');
  const bars = await page2.engine.oi(ID, MIN, minute - 2 * MIN, minute + MIN);
  assert.deepEqual(bars.map(b => b[4]), [150, 500], 'and the series shows the newer');
  page.engine.stop(); page2.engine.stop();
});

test('past the most it keeps before the hand-over, what was kept is played in and the trades are not covered past it', () => {
  const T = Date.UTC(2026, 10, 3, 12, 0, 20), clock = { now: T }, page = open(clock, { deferred: true });
  page.venue.state = 'live';
  page.venue.trade({ tradeId: 'a', side: 'buy', price: 100, amount: 1, t: T });
  for (let k = 0; k < 4; k++) { clock.now += 250; page.engine.step(clock.now); }
  // A venue sending one trade again and again until nothing more is kept, then a new trade.
  for (let i = 0; i < 100_000; i++) page.venue.trade({ tradeId: 'a', side: 'buy', price: 100, amount: 1, t: T });
  const lastKept = clock.now;
  clock.now += 2_000; page.engine.step(clock.now);
  page.venue.trade({ tradeId: 'b', side: 'sell', price: 100, amount: 1, t: clock.now });
  clock.now += 2_000; page.engine.step(clock.now);
  page.engine.attach(null);
  assert.deepEqual(profile(page.engine, T - MIN, T + MIN), [[100, 100, 0]], 'the trade kept is there, once');
  const covered = page.engine.tradeCoverage.covered(ID, T - MIN, clock.now);
  assert.ok(covered.length > 0 && covered.at(-1)![1] <= lastKept, `not covered past the last kept note: ${JSON.stringify(covered)}`);
  page.engine.stop();
});

test('an order announced before the hand-over is announced once, however the replay completes it', () => {
  const T = Date.UTC(2026, 10, 3, 12, 0, 20), from = T - MIN, to = T + MIN, stores = memoryStores();
  // A trade recorded on the visit before, five seconds before this one started.
  const prior = { now: T - 5_000 }, before = open(prior, { stores });
  before.venue.trade({ tradeId: 'r', side: 'sell', price: 99, amount: 10, t: T - 5_000 });
  before.engine.stop();
  // A large new order, then the venue sending that recorded trade again: live, it closes the new order, which is announced at once; the
  // replay drops the resend (the recordings hold it), so the new order is completed again later.
  const clock = { now: T }, page = open(clock, { deferred: true });
  page.venue.trade({ tradeId: 'n', side: 'buy', price: 101, amount: 1_000, t: T + 100 });
  clock.now = T + 110; page.venue.trade({ tradeId: 'r', side: 'sell', price: 99, amount: 10, t: T - 5_000 });
  clock.now = T + 120; page.engine.step(clock.now);
  assert.deepEqual(page.fresh.map(p => p.usd), [101_000]);
  page.engine.attach({ ...noStores, ...stores });
  clock.now = T + 1_000; page.engine.step(clock.now);
  assert.deepEqual(page.fresh.map(p => p.usd), [101_000], 'one new print');
  assert.equal(page.tape.filter(usd => usd === 101_000).length, 1, 'one order in the trade dust');
  assert.deepEqual(page.engine.prints(from, to).map(p => p.usd), [101_000], 'recorded once');

  // Past the most it keeps: the last kept note is a large trade whose taking was not kept.
  const c2 = { now: T }, full = open(c2, { deferred: true });
  full.venue.trade({ tradeId: 'a', side: 'sell', price: 100, amount: 1, t: T });
  full.venue.trade({ tradeId: 'L', side: 'buy', price: 102, amount: 1_000, t: T + 1 });
  for (let i = 0; i < 100_000; i++) full.venue.trade({ tradeId: 'a', side: 'sell', price: 100, amount: 1, t: T });
  c2.now = T + 1_000; full.engine.step(c2.now);
  assert.deepEqual(full.fresh.map(p => p.usd), [102_000]);
  full.engine.attach(null);
  c2.now = T + 2_000; full.engine.step(c2.now);
  assert.deepEqual(full.fresh.map(p => p.usd), [102_000], 'one new print');
  assert.equal(full.tape.filter(usd => usd === 102_000).length, 1, 'one order in the trade dust');
  page.engine.stop(); full.engine.stop();
});

test('an order from before the page opened, played in at the hand-over and completed after it, is recorded and never announced', () => {
  const T = Date.UTC(2026, 10, 3, 12, 0, 20), clock = { now: T }, page = open(clock, { deferred: true });
  clock.now = T + 50; page.venue.trade({ tradeId: 'h', side: 'buy', price: 101, amount: 1_000, t: T - 20_000 });
  clock.now = T + 60; page.engine.attach(null);
  clock.now = T + 1_000; page.engine.step(clock.now);
  assert.deepEqual(page.fresh, []);
  assert.deepEqual(page.tape, []);
  assert.deepEqual(page.engine.prints(T - MIN, T + MIN).map(p => p.usd), [101_000], 'recorded');
  page.engine.stop();
});

/** A stored minute of the test's book on `step`, as the recordings hand it to the recorders. */
const storedMinute = (t: number, step: number, n = 12): { instrumentId: string; step: number; column: Column } =>
  ({ instrumentId: ID, step, column: { t, n, bins: Int32Array.of(4_990, 5_060), bid: Float32Array.of(2_000, 0), ask: Float32Array.of(0, 3_000) } });

test('the newest recordings answer the map while the rest is read back: with the live samples since, never written, replaced at the hand-over', () => {
  const T = Date.UTC(2026, 10, 7, 12, 0, 20), minute = Math.floor(T / MIN) * MIN, step = gridStepFor(100);
  const clock = { now: T }, page = open(clock, { deferred: true });
  const times = (from: number, to: number): number[] => page.engine.columns([ID], from, to, MIN).instruments[0]?.times ?? [];
  page.venue.book(100, 101, 50);
  page.engine.step(T);
  assert.deepEqual(times(minute - 120 * MIN, minute + MIN), [minute], 'before them: the live minute alone');
  const newest = [storedMinute(minute - 3 * MIN, step), storedMinute(minute - 2 * MIN, step)];
  let writes = 0;
  const head: ColumnStore = { load: () => newest, save: () => { writes++; }, prune: () => { writes++; } };
  assert.equal(page.engine.preview(head), true);
  assert.deepEqual(times(minute - 120 * MIN, minute + MIN), [minute - 3 * MIN, minute - 2 * MIN], 'the newest recordings (the sample before them is not theirs)');
  assert.equal(page.engine.heldSince([ID], CONTIGUOUS_GAP_MS)[ID], minute - 3 * MIN);
  clock.now = T + SAMPLE_MS; page.engine.step(clock.now);
  assert.deepEqual(times(minute - 120 * MIN, minute + MIN), [minute - 3 * MIN, minute - 2 * MIN, minute], 'with the live samples since');
  clock.now = minute + MIN + 1_000; page.engine.step(clock.now);
  assert.equal(writes, 0, 'nothing is written from them, the minute they completed included');
  // The hand-over: the whole recordings, and every sample since the start played in (the one from before the newest recordings came too).
  const saved: number[] = [];
  const whole: ColumnStore = { load: () => [storedMinute(minute - 90 * MIN, step), ...newest], save: (_id, column) => { saved.push(column.t); }, prune: () => {} };
  page.engine.attach({ ...noStores, columns: whole });
  assert.deepEqual(times(minute - 120 * MIN, minute + 2 * MIN), [minute - 90 * MIN, minute - 3 * MIN, minute - 2 * MIN, minute, minute + MIN]);
  assert.equal(page.engine.columns([ID], minute, minute + MIN, MIN).instruments[0]!.samples[0], 2, 'the minute holds both of its samples');
  assert.deepEqual(saved, [minute], 'the minute completed is written once, by the recorder the hand-over built');
  assert.equal(page.engine.preview(whole), false, 'handed over: nothing more to preview');
  page.engine.stop();
});

test('a book the newest recordings keep on another step takes no live samples into them (its far levels are merged on the live step)', () => {
  const T = Date.UTC(2026, 10, 7, 12, 0, 20), minute = Math.floor(T / MIN) * MIN, clock = { now: T }, page = open(clock, { deferred: true });
  page.venue.book(100, 101, 50);
  page.engine.step(T);
  assert.equal(page.engine.preview({ load: () => [storedMinute(minute - 2 * MIN, gridStepFor(100) * 5)] }), true);
  clock.now = T + SAMPLE_MS; page.engine.step(clock.now);
  assert.deepEqual(page.engine.columns([ID], minute - 10 * MIN, minute + MIN, MIN).instruments[0]!.times, [minute - 2 * MIN], 'the live minute is not among them');
  page.engine.stop();
});

test('a book the newest recordings hold nothing of is kept in them on the live step it is valued on, wherever its price has gone since', () => {
  const T = Date.UTC(2026, 10, 7, 12, 0, 20), minute = Math.floor(T / MIN) * MIN, clock = { now: T }, page = open(clock, { deferred: true });
  page.venue.book(100, 101, 50);
  page.engine.step(T);
  const live = gridStepFor(100);
  assert.equal(page.engine.preview({ load: () => [{ ...storedMinute(minute - 2 * MIN, 1), instrumentId: 'other:BTCUSDT' }] }), true);
  // Its price has crossed into a finer grid since the live recorder chose its step (gridStepFor(70) is half of gridStepFor(100)).
  page.venue.book(70, 71, 50);
  clock.now = T + SAMPLE_MS; page.engine.step(clock.now);
  const set = page.engine.columns([ID], minute - 10 * MIN, minute + MIN, MIN).instruments[0]!;
  assert.deepEqual(set.times, [minute]);
  assert.equal(set.step, live, 'the live recorder\'s step, not one of its own');
  page.engine.stop();
});

test('with no newest minutes the map waits for the recordings, and an engine that has them, or was handed them, previews nothing', () => {
  const T = Date.UTC(2026, 10, 7, 12, 0, 20), clock = { now: T };
  const page = open(clock, { deferred: true }), started = open(clock, {});
  const newest = [storedMinute(Math.floor(T / MIN) * MIN - 2 * MIN, gridStepFor(100))];
  assert.equal(page.engine.preview({ load: () => [] }), false, 'none held');
  assert.deepEqual(page.engine.columns([ID], T - 60 * MIN, T + MIN, MIN).instruments[0]?.times ?? [], [], 'the live recorder answers (nothing yet)');
  assert.equal(started.engine.preview({ load: () => newest }), false, 'started with its recordings');
  page.engine.attach(null);
  assert.equal(page.engine.preview({ load: () => newest }), false, 'handed over');
  page.engine.stop(); started.engine.stop();
});
