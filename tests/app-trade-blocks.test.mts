import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { SecondTally, LATE_MS, type TallyFilter } from '../src/app/trades/tally.ts';
import { BlockReader, FROM, OrderScan, barLength, coincidences, emptyBlock, fullScale, repeats, type FlowLike, type NoteOrder } from '../src/app/trades/blocks.ts';
import { RUN_MAX, RowWalker } from '../src/app/trades/rows.ts';
import { focusWindow } from '../src/app/panes/heat-zoom.ts';
import { RECORDED_AGAIN_MS, recordedDue, recordedSeam } from '../src/app/trades/asks.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { TRADES_DEFAULTS, readTrades, readUnit } from '../src/app/trades/settings.ts';

/** A batch of orders: [market, exchange time, price, signed usd]. */
function batch(seq: number, rows: [string, number, number, number][]): TapeBatch {
  const ids = [...new Set(rows.map(r => r[0]))], n = rows.length;
  const b: TapeBatch = { seq, dropped: 0, ids, inst: new Int32Array(n), t: new Float64Array(n), price: new Float64Array(n), usd: new Float32Array(n), lo: new Float64Array(n), hi: new Float64Array(n) };
  rows.forEach(([id, t, price, usd], i) => { b.inst[i] = ids.indexOf(id); b.t[i] = t; b.price[i] = price; b.usd[i] = usd; b.lo[i] = price - 1; b.hi[i] = price + 1; });
  return b;
}
const B = 'binance:BTCUSDT', O = 'okx:BTC-USDT-SWAP', BS = 'binancespot:BTCUSDT';
const T0 = 1_800_000_000_000;
const all = { minUsd: 0, side: 'both' as const, shown: () => true };
const venueSlot = (id: string): number => id.startsWith('binance') ? 0 : 1;

/** A reader on a tally over `ring` with the two venues' slots. */
function reader(ring: TapeRing, filter: TallyFilter = all, markets = [B, BS, O]): { tally: SecondTally; r: BlockReader } {
  const tally = new SecondTally(3600); tally.reset(ring, filter); while (tally.filling) tally.fill();
  const r = new BlockReader(); r.tally = tally; r.markets = markets; r.ref = B; r.minUsd = filter.minUsd; r.side = filter.side;
  r.setVenues(2, venueSlot);
  return { tally, r };
}

test('the unit and the settings read back: one second by default, each order is 0, a custom length up to fifteen minutes', () => {
  assert.equal(TRADES_DEFAULTS.unit, 1);
  assert.deepEqual(readTrades(undefined), { unit: 1, minUsd: 0, side: 'both', group: false });
  assert.equal(readTrades({ minUsd: 5_000, side: 'sell', group: true }).unit, 1, 'a save from before the unit opens on a second');
  assert.equal(readTrades({ unit: 0 }).unit, 0);
  assert.equal(readTrades({ unit: 300 }).unit, 300);
  assert.equal(readUnit(901, 1), 1); assert.equal(readUnit(2.5, 1), 1); assert.equal(readUnit(-1, 60), 60); assert.equal(readUnit(7, 1), 7);
});

test('the tally adds each second up per market: bought, sold, the count, the largest buy and sell, and every order\'s VWAP', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 100, 70_000, 10_000], [O, T0 + 200, 70_010, -4_000], [B, T0 + 900, 70_020, 30_000], [BS, T0 + 950, 70_030, -500]]), 1, 0);
  ring.add(batch(2, [[B, T0 + 1_100, 70_040, -2_000]]), 1, 0);
  const { tally } = reader(ring);
  const s = tally.slot(T0 / 1000), m = (id: string): number => ring.ids.indexOf(id);
  assert.equal(tally.count(s), 4);
  assert.equal(tally.buy(m(B), s), 40_000); assert.equal(tally.sell(m(O), s), 4_000); assert.equal(tally.sell(m(BS), s), 500);
  assert.equal(tally.topBuy(s), 30_000); assert.equal(ring.at(tally.topBuyK(s)).t, T0 + 900);
  assert.equal(tally.topSell(s), 4_000);
  assert.equal(Math.round(tally.vwap(m(B), s) * 100) / 100, Math.round((70_000 * 10_000 + 70_020 * 30_000) / 40_000 * 100) / 100);
  assert.equal(tally.count(tally.slot(T0 / 1000 + 1)), 1);
  assert.equal(tally.slot(T0 / 1000 + 2), -1, 'a second with no order has no slot');
});

test('a size floor and a side count only what passes, but a second\'s VWAP is every order\'s (the price change ignores the filter)', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 100, 70_000, 500], [B, T0 + 200, 70_100, 20_000], [B, T0 + 300, 70_200, -15_000]]), 1, 0);
  const { tally } = reader(ring, { minUsd: 10_000, side: 'buy', shown: () => true });
  const s = tally.slot(T0 / 1000), m = ring.ids.indexOf(B);
  assert.equal(tally.count(s), 1); assert.equal(tally.buy(m, s), 20_000); assert.equal(tally.sell(m, s), 0);
  const all3 = (70_000 * 500 + 70_100 * 20_000 + 70_200 * 15_000) / 35_500;
  assert.ok(Math.abs(tally.vwap(m, s) - all3) < 1e-6);
});

test('a late order lands in its own second; one later than the window marks its market late for half a minute', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 10_000, 70_000, 1_000]]), 1, 0);
  const { tally } = reader(ring);
  ring.add(batch(2, [[O, T0 + 10_000 - LATE_MS - 500, 70_000, 2_000], [B, T0 + 10_200, 70_000, 1_000]]), 1, 0);
  tally.update();
  assert.equal(tally.sell(ring.ids.indexOf(O), tally.slot(T0 / 1000 + 6)), 0);
  assert.equal(tally.buy(ring.ids.indexOf(O), tally.slot(T0 / 1000 + 6)), 2_000, 'the late order went to its own second');
  assert.deepEqual(tally.late(), [ring.ids.indexOf(O)]);
  ring.add(batch(3, [[B, T0 + 50_000, 70_000, 1_000]]), 1, 0);
  tally.update();
  assert.deepEqual(tally.late(), [], 'forgotten half a minute later');
});

test('starting over reads the ring back in steps, and the covered start follows how far it has read', () => {
  const ring = new TapeRing(BLOCK);
  let seq = 1;
  for (let i = 0; i < 300; i++) ring.add(batch(seq++, [[B, T0 + i * 100, 70_000, 1_000]]), 1, 0);
  const tally = new SecondTally(3600); tally.reset(ring, all);
  assert.equal(tally.update(), 0, 'nothing new since the start over');
  assert.equal(tally.coveredFrom(), Infinity, 'nothing held yet');
  assert.equal(tally.fill(100), 100);
  assert.ok(tally.filling);
  assert.equal(tally.coveredFrom(0), T0 + 200 * 100, 'covered from the oldest write read');
  while (tally.filling) tally.fill(64);
  assert.equal(tally.coveredFrom(), T0, 'all read: from the ring\'s own start');
  let total = 0;
  for (let sec = T0 / 1000; sec < T0 / 1000 + 30; sec++) { const s = tally.slot(sec); if (s >= 0) total += tally.count(s); }
  assert.equal(total, 300);
});

test('the hold counts the orders that pass as they come; a cleared ring starts over', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0, 70_000, 1_000]]), 1, 0);
  const { tally } = reader(ring, { minUsd: 500, side: 'both', shown: () => true });
  tally.hold();
  ring.add(batch(2, [[B, T0 + 10, 70_000, 2_000], [B, T0 + 20, 70_000, 100]]), 1, 0);
  tally.update();
  assert.equal(tally.newSinceHold, 1);
  tally.release(); assert.equal(tally.newSinceHold, 0);
  const resets = tally.resets;
  ring.clear(); ring.add(batch(1, [[B, T0 + 99_000, 70_000, 1_000]]), 2, 0);
  tally.update();
  assert.equal(tally.resets, resets + 1);
});

test('a block adds its seconds up; venues keep their slots; spot and perpetual of one venue share one', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0, 70_000, 10_000], [BS, T0 + 1_100, 70_030, 5_000], [O, T0 + 2_200, 70_010, -4_000], [B, T0 + 61_000, 70_000, 9_000]]), 1, 0);
  const { r } = reader(ring);
  const out = emptyBlock(2);
  r.read(T0 / 1000, 60, out, T0 + 200_000);
  assert.equal(out.buy, 15_000); assert.equal(out.sell, 4_000); assert.equal(out.n, 3);
  assert.equal(out.vBuy[0], 15_000, 'binance and binance spot in one slot'); assert.equal(out.vSell[1], 4_000);
  assert.equal(out.topBuy.usd, 10_000); assert.equal(out.topBuy.id, B); assert.equal(out.topSell.usd, 4_000);
  // The tape's first second, begun part-way, is not counted as covered: a block starting there would be partial.
  assert.equal(out.from, FROM.tape); assert.equal(out.partial, false); assert.equal(out.forming, false);
  r.read(T0 / 1000 + 60, 60, out, T0 + 61_500);
  assert.equal(out.forming, true, 'the minute under way');
  assert.equal(out.n, 1);
});

test('the reference market\'s VWAP: the block\'s last second that traded, and the last second before it within reach', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 100, 70_000, 1_000], [B, T0 + 2_100, 70_050, 1_000], [O, T0 + 3_100, 70_900, 1_000]]), 1, 0);
  const { r } = reader(ring);
  const out = emptyBlock(2);
  r.read(T0 / 1000 + 3, 1, out, T0 + 10_000);
  assert.ok(Number.isNaN(out.refPx), 'the reference market did not trade in it');
  assert.equal(out.refPrev, 70_050, 'its last second before it, one second back');
  r.read(T0 / 1000 + 5, 1, out, T0 + 10_000);
  assert.ok(Number.isNaN(out.refPrev), 'nothing within two seconds before');
});

test('before the tape: any size reads the flow (no count), a size floor the recording (from its floor), under $25K nothing', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 3_600_000, 70_000, 1_000]]), 1, 0);
  const startSec = T0 / 1000;
  const flow = (buyPerSec: number): FlowLike => ({ buy: (a, z) => (z - a + 1) * buyPerSec, sell: (a, z) => (z - a + 1) * 10, ownPrice: () => 69_000, span: { first: startSec, last: startSec + 7200 } });
  const flows = new Map([[B, flow(100)], [O, flow(50)]]);
  const { r } = reader(ring);
  r.flowOf = id => flows.get(id);
  r.recorded = { prints: [{ t: T0 + 30_000, id: O, side: 'sell', price: 69_100, usd: 400_000 }, { t: T0 + 31_000, id: B, side: 'buy', price: 69_000, usd: 30_000 }], from: T0, to: T0 + 3_600_000, holes: [], minUsd: 25_000 };
  const out = emptyBlock(2);
  r.read(startSec, 60, out, T0 + 3_700_000);
  assert.equal(out.from, FROM.flow); assert.equal(out.n, -1);
  assert.equal(out.buy, 60 * 150); assert.equal(out.vBuy[0], 6_000); assert.equal(out.vBuy[1], 3_000);
  assert.equal(out.topSell.usd, 400_000); assert.equal(out.topSell.recorded, true, 'named from the recording');
  assert.equal(out.refPx, 69_000);
  r.minUsd = 25_000;
  r.read(startSec, 60, out, T0 + 3_700_000);
  assert.equal(out.from, FROM.prints); assert.equal(out.buy, 30_000); assert.equal(out.sell, 400_000);
  r.minUsd = 5_000;
  r.read(startSec, 60, out, T0 + 3_700_000);
  assert.equal(out.unknown, true, 'no source counts orders from $5K before the tape');
  assert.equal(r.oldestSec(), Math.ceil((T0 + 3_600_000) / 1000), 'the list ends where the tape starts');
});

test('before the recording\'s hour, any size names a block\'s largest orders from an older stretch that holds the whole block, never counts them', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 3_600_000, 70_000, 1_000]]), 1, 0);
  const startSec = T0 / 1000;
  const flow: FlowLike = { buy: (a, z) => (z - a + 1) * 100, sell: (a, z) => (z - a + 1) * 10, ownPrice: () => 69_000, span: { first: startSec, last: startSec + 7200 } };
  const { r } = reader(ring);
  r.flowOf = id => id === B ? flow : undefined;
  r.recorded = { prints: [], from: T0 + 1_800_000, to: T0 + 3_600_000, holes: [], minUsd: 25_000 };
  const out = emptyBlock(2);
  r.read(startSec, 60, out, T0 + 3_700_000);
  assert.equal(out.topBuy.has, false, 'no older stretch yet');
  r.older = [{ from: T0, to: T0 + 600_000, floor: 25_000, prints: [
    { t: T0 + 10_000, id: B, side: 'buy', price: 69_000, usd: 900_000 },
    { t: T0 + 20_000, id: 'kraken:XBTUSD', side: 'buy', price: 69_000, usd: 5_000_000 },
    { t: T0 + 70_000, id: O, side: 'sell', price: 69_000, usd: 300_000 },
  ] }];
  r.forget();
  r.read(startSec, 60, out, T0 + 3_700_000);
  assert.equal(out.topBuy.usd, 900_000, 'the largest of the markets counted (one not counted is left out)');
  assert.equal(out.topBuy.recorded, true);
  assert.equal(out.topSell.has, false, 'an order after the block is not its own');
  assert.equal(out.buy, 6_000, 'the totals stay the flow\'s');
  r.read(startSec + 540, 120, out, T0 + 3_700_000);
  assert.equal(out.topBuy.has, false, 'a block the stretch does not hold whole is not named from it');
});

test('before the tape, a block over a stretch the recording did not listen to is partial: its flow zeros are not quiet seconds', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 3_600_000, 70_000, 1_000]]), 1, 0);
  const startSec = T0 / 1000;
  const flow: FlowLike = { buy: (a, z) => (z - a + 1) * 100, sell: (a, z) => (z - a + 1) * 10, ownPrice: () => 69_000, span: { first: startSec, last: startSec + 7200 } };
  const { r } = reader(ring);
  r.flowOf = id => id === B ? flow : undefined;
  r.holes = [[T0 + 20_000, T0 + 40_000]];
  const out = emptyBlock(2);
  r.read(startSec, 60, out, T0 + 3_700_000);
  assert.equal(out.partial, true, 'the hole falls in it');
  assert.equal(out.unrecorded, false, 'the rest of the minute was recorded');
  r.read(startSec + 60, 60, out, T0 + 3_700_000);
  assert.equal(out.partial, false, 'the next minute was recorded');
  // A block wholly in the hole with nothing in it is unrecorded (the list folds a run of them into one line); one with dollars is not.
  const quiet: FlowLike = { buy: (a, z) => (a >= startSec + 20 && z < startSec + 40 ? 0 : (z - a + 1) * 100), sell: () => 0, ownPrice: () => 69_000, span: flow.span };
  r.flowOf = id => id === B ? quiet : undefined; r.forget();
  r.read(startSec + 25, 5, out, T0 + 3_700_000);
  assert.equal(out.unrecorded, true);
  r.flowOf = id => id === B ? flow : undefined; r.forget();
  r.read(startSec + 25, 5, out, T0 + 3_700_000);
  assert.equal(out.unrecorded, false, 'dollars in it: partial, drawn as a block');
});

test('a block across the tape\'s start mixes sources: partial and no count; a reconnect inside one makes it partial', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 30_500, 70_000, 1_000]]), 1, 0);
  const { r } = reader(ring);
  r.flowOf = () => ({ buy: (a, z) => (z - a + 1) * 100, sell: () => 0, ownPrice: () => 0, span: { first: T0 / 1000, last: T0 / 1000 + 100 } });
  const out = emptyBlock(2);
  r.read(T0 / 1000, 60, out, T0 + 200_000);
  assert.equal(out.from, FROM.flow | FROM.tape); assert.equal(out.partial, true); assert.equal(out.n, -1);
  r.flowOf = null; r.gaps = [[T0 + 40_000, T0 + 41_000]];
  r.read(T0 / 1000 + 30, 30, out, T0 + 200_000);
  assert.equal(out.partial, true);
});

test('the bar scale: square root, full at about a week\'s 99th percentile, interpolated in logs between the units', () => {
  const near = (a: number, b: number): boolean => Math.abs(a / b - 1) < 1e-9;
  assert.equal(fullScale(1), 2.5e6); assert.ok(near(fullScale(60), 100e6)); assert.ok(near(fullScale(300), 500e6)); assert.ok(near(fullScale(900), 1.2e9));
  assert.ok(fullScale(10) > fullScale(1) && fullScale(10) < fullScale(60));
  assert.ok(Math.abs(Math.log(fullScale(30)) - (Math.log(2.5e6) + (Math.log(100e6) - Math.log(2.5e6)) * Math.log(30) / Math.log(60))) < 1e-9);
  assert.equal(barLength(2.5e6, 2.5e6, 109), 109); assert.equal(barLength(5e6, 2.5e6, 109), 109, 'capped');
  assert.ok(Math.abs(barLength(25e4, 2.5e6, 109) / barLength(25e3, 2.5e6, 109) - Math.sqrt(10)) < 1e-9, 'ten times larger: 3.16 times longer');
  assert.equal(barLength(1, 2.5e6, 109), 1, 'a positive side is never under a pixel'); assert.equal(barLength(0, 2.5e6, 109), 0);
});

test('notes: orders on two or more venues within 5 ms (never chained past it), and runs of nearly equal sizes', () => {
  const o = (t: number, venue: string, usd: number, id = `${venue}:X`): { t: number; id: string; venue: string; usd: number } => ({ t, id, venue, usd });
  const found = coincidences([o(0, 'okx', 3e6), o(2, 'bybit', 5.8e5), o(4, 'bitget', 3.2e5), o(8, 'binance', 2e5), o(100, 'binance', 2e5), o(101, 'binance', 2e5)], 1e5);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.venues, ['okx', 'bybit', 'bitget']);
  assert.equal(found[0]!.usd, 3e6 + 5.8e5 + 3.2e5);
  assert.equal(coincidences([o(0, 'okx', 3e6), o(3, 'bybit', -5e5)], 1e5).length, 0, 'one side only');
  const runs = repeats([o(0, 'bybit', 800), o(1, 'bybit', 801), o(2, 'bybit', 799), o(3, 'bybit', 800), o(4, 'bybit', 800), o(5, 'bybit', 2_000), o(6, 'okx', 800)]);
  assert.equal(runs.length, 1); assert.equal(runs[0]!.n, 5); assert.equal(runs[0]!.lo, 799); assert.equal(runs[0]!.hi, 801);
  assert.equal(repeats([o(0, 'bybit', 800), o(20_000, 'bybit', 800), o(20_001, 'bybit', 800), o(20_002, 'bybit', 800), o(20_003, 'bybit', 800)]).length, 0, 'a gap over ten seconds breaks the run');
});

// ---- review round 1 (2026-11-13): each claim as a test ------------------------------------------------------------------------------

test('a stretch with no price keeps the map\'s price window: a block whose reference market did not trade sends none', () => {
  const view = { t0: 0, t1: 600_000, p0: 100, p1: 200 };
  const w = focusWindow(view, { t0: 100_000, t1: 160_000, p0: NaN, p1: NaN });
  assert.deepEqual([w.p0, w.p1], [100, 200]);
  assert.ok(w.t0 < 100_000 && w.t1 > 160_000 && w.t1 - w.t0 === 600_000);
  const z = focusWindow(view, { t0: 100_000, t1: 160_000, p0: 150, p1: 150 });
  assert.deepEqual([z.p0, z.p1], [100, 200]);
});

/** A ring of one $5K buy a second on Binance from T0 for `seconds`. */
function steady(seconds: number): TapeRing {
  const ring = new TapeRing(BLOCK), rows: [string, number, number, number][] = [];
  for (let i = 0; i < seconds; i++) rows.push([B, T0 + i * 1000, 70_000, 5_000]);
  ring.add(batch(1, rows), 1, 0);
  return ring;
}

test('a block read while the tally reads back is not kept: once the tally holds every write, it reads whole', () => {
  const ring = steady(240), tally = new SecondTally(3600);
  tally.reset(ring, all); tally.fill(90);
  const r = new BlockReader(); r.tally = tally; r.markets = [B, BS, O]; r.ref = B; r.setVenues(2, venueSlot);
  const out = emptyBlock(2), s = T0 / 1000 + 120, now = T0 + 3_600_000;
  r.read(s, 60, out, now);
  assert.equal(out.partial, true, 'the covered start falls inside it while reading back');
  while (tally.filling) tally.fill();
  r.read(s, 60, out, now);
  assert.equal(out.partial, false); assert.equal(out.buy, 60 * 5_000); assert.equal(out.n, 60);
});

test('a kept block is read again when the flow is loaded again or a reconnect falls in it', () => {
  const { r } = reader(steady(240));
  let per = 100, version = 0;
  const startSec = T0 / 1000 - 600;
  r.flowOf = id => id === B ? { buy: (a, z) => (z - a + 1) * per, sell: () => 0, ownPrice: () => 69_000, span: { first: startSec, last: startSec + 7200 } } : undefined;
  r.flowVersion = () => version;
  const out = emptyBlock(2), now = T0 + 3_600_000;
  r.read(startSec, 60, out, now);
  assert.equal(out.buy, 6_000);
  per = 200; version++;
  r.read(startSec, 60, out, now);
  assert.equal(out.buy, 12_000, 'the flow was loaded again');
  const t = T0 / 1000 + 60;
  r.read(t, 60, out, now);
  assert.equal(out.partial, false);
  r.gaps = [[(t + 10) * 1000, (t + 20) * 1000]];
  r.read(t, 60, out, now);
  assert.equal(out.partial, true, 'a reconnect inside it, met after it was kept');
});

test('with a size floor, time between the recording\'s end and the tape\'s start is not recorded, not quiet', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 3_600_000, 70_000, 30_000]]), 1, 0);
  const { r } = reader(ring, { minUsd: 25_000, side: 'both', shown: () => true });
  r.recorded = { prints: [{ t: T0 + 30_000, id: B, side: 'buy', price: 69_000, usd: 40_000 }], from: T0, to: T0 + 600_000, holes: [], minUsd: 25_000 };
  const out = emptyBlock(2), now = T0 + 3_700_000;
  r.read(T0 / 1000 + 1_800, 60, out, now);
  assert.equal(out.unknown, false); assert.equal(out.unrecorded, true, 'past the recording\'s end');
  r.read(T0 / 1000 + 570, 60, out, now);
  assert.equal(out.partial, true, 'across the recording\'s end');
  r.read(T0 / 1000, 60, out, now);
  assert.equal(out.buy, 40_000); assert.equal(out.unrecorded, false);
});

test('Side holds for the flow before the tape: buys only reads no sells there, in the blocks and their market rows', () => {
  const { r } = reader(steady(10));
  const startSec = T0 / 1000 - 600;
  r.flowOf = id => id === B ? { buy: (a, z) => (z - a + 1) * 100, sell: (a, z) => (z - a + 1) * 40, ownPrice: () => 69_000, span: { first: startSec, last: startSec + 7200 } } : undefined;
  r.side = 'buy';
  const out = emptyBlock(2);
  r.read(startSec, 60, out, T0 + 3_600_000);
  assert.equal(out.buy, 6_000); assert.equal(out.sell, 0);
  assert.equal(r.marketRows(startSec, 60).find(m => m.id === B)!.sell, 0);
});

test('a mixed block keeps the larger of the recording\'s and the tape\'s largest orders', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 40_000, 70_000, 40_000]]), 1, 0);
  const { r } = reader(ring, { minUsd: 25_000, side: 'both', shown: () => true });
  r.recorded = { prints: [{ t: T0 + 10_000, id: O, side: 'buy', price: 69_000, usd: 3_000_000 }], from: T0 - 600_000, to: T0 + 40_000, holes: [], minUsd: 25_000 };
  const out = emptyBlock(2);
  r.read(T0 / 1000, 60, out, T0 + 3_600_000);
  assert.equal(out.topBuy.usd, 3_000_000); assert.equal(out.topBuy.id, O);
});

test('the one-pass scan finds what the old pipeline found: the largest (ties in order), the big ones, the repeated sizes', () => {
  let seed = 11;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ids = [B, O, BS, 'bybit:BTCUSDT'];
  for (let round = 0; round < 60; round++) {
    const orders: (NoteOrder & { price: number; lo: number; hi: number })[] = [];
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += Math.floor(rand() * 400);
      const id = ids[Math.floor(rand() * ids.length)]!, base = [800, 25_000, 120_000, 5][Math.floor(rand() * 4)]!;
      const usd = (rand() < 0.5 ? 1 : -1) * (rand() < 0.3 ? base : Math.round(base * (0.5 + rand())));
      orders.push({ t, id, venue: id.split(':')[0]!, usd, price: 70_000, lo: 70_000, hi: 70_000 });
    }
    if (round % 3 === 0) orders.reverse();
    const scan = new OrderScan(id => id.split(':')[0]!), floor = round % 2 ? 0 : 1_000, k = 9;
    scan.reset(k, floor, 100_000);
    for (const o of orders) scan.add(ids.indexOf(o.id), o.id, o.t, o.usd, o.price, o.lo, o.hi);
    const largest = [...orders].filter(o => Math.abs(o.usd) >= floor).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, k);
    assert.deepEqual(scan.largest.map(o => [o.t, o.id, o.usd]), largest.map(o => [o.t, o.id, o.usd]), `round ${round}: largest`);
    assert.deepEqual(coincidences(scan.big, 100_000), coincidences(orders, 100_000), `round ${round}: coincidences`);
    assert.deepEqual(scan.repeats(), repeats(orders), `round ${round}: repeats`);
  }
});

test('rows: a run of empty blocks of one kind is one row, cut every RUN_MAX blocks on the clock, the same walked down or up', () => {
  const ring = steady(10), { r } = reader(ring);
  const startSec = T0 / 1000 - 3 * RUN_MAX - 50;
  const quietUntil = T0 / 1000 - 30;
  r.flowOf = id => id === B ? { buy: (a, z) => { let n = 0; for (let s = a; s <= z; s++) if (s >= quietUntil || s < startSec + 5) n += 100; return n; }, sell: () => 0, ownPrice: () => 69_000, span: { first: startSec, last: T0 / 1000 + 10 } } : undefined;
  const w = new RowWalker(r), now = T0 + 3_600_000, oldest = r.oldestSec();
  const down = [];
  for (let row = w.rowFrom(quietUntil - 1, 1, now, oldest); row && down.length < 10; row = w.below(row, 1, now, oldest)) down.push(row);
  const folds = down.filter(x => x.kind === 'empty');
  assert.ok(folds.length >= 3, 'cut into rows of at most RUN_MAX');
  for (const f of folds) { assert.ok(f.top - f.bottom + 1 <= RUN_MAX); assert.equal(Math.floor(f.top / RUN_MAX), Math.floor(f.bottom / RUN_MAX), 'within one clock-aligned stretch'); }
  for (let i = 1; i < down.length; i++) assert.deepEqual(w.above(down[i]!, 1, now, quietUntil + 100), down[i - 1], `row ${i} walked up`);
  r.gaps = [[(startSec + 100) * 1000, (startSec + 200) * 1000]];
  const g = w.rowFrom(startSec + 150, 1, now, oldest)!;
  assert.equal(g.kind, 'missing', 'empty blocks a reconnect falls in: orders may be missing there');
});

// ---- review round 2 ------------------------------------------------------------------------------------------------------------

test('the recording is asked again only when the seam moved five minutes, a smaller size is wanted, or a wait is over: never at once after an answer', () => {
  const now = T0;
  assert.equal(recordedSeam({ blocks: true, ringFrom: null, covered: T0, filling: false }), null, 'no ring yet: not asked');
  assert.equal(recordedSeam({ blocks: true, ringFrom: T0, covered: T0 + 3_600_000, filling: true }), null, 'the tally reading back: its start moves');
  assert.equal(recordedSeam({ blocks: true, ringFrom: T0, covered: T0 + 3_600_000, filling: false }), T0 + 3_600_000, 'the blocks: from where the tally starts');
  assert.equal(recordedSeam({ blocks: false, ringFrom: T0, covered: T0 + 3_600_000, filling: false }), T0, 'each order: from the ring\'s oldest order');
  // The loop round 2 found: the tally's window an hour shorter than the ring. Answered at that seam, nothing is due again.
  const seam = T0 + 3_600_000, done = { state: 'done' as const, askedAt: seam, min: 25_000, retryAt: 0 };
  assert.equal(recordedDue(done, seam, 25_000, now), false);
  assert.equal(recordedDue(done, seam + RECORDED_AGAIN_MS - 1, 25_000, now), false);
  assert.equal(recordedDue(done, seam + RECORDED_AGAIN_MS + 1, 25_000, now), true, 'the seam moved on');
  assert.equal(recordedDue(done, seam, 10_000, now), true, 'a smaller size');
  assert.equal(recordedDue({ ...done, state: 'asking' }, seam + 10 * RECORDED_AGAIN_MS, 1, now), false, 'one question at a time');
  assert.equal(recordedDue({ state: 'no', askedAt: 0, min: Infinity, retryAt: now + 1 }, seam, 25_000, now), false, 'a failure waits');
  assert.equal(recordedDue({ state: 'no', askedAt: 0, min: Infinity, retryAt: 0 }, seam, 25_000, now), true);
});

test('quiet is per market: one known from before the block counts whole, one whose flow begins later makes it partial, a stray second claims nothing', () => {
  const { r } = reader(steady(10), all, [B, O]);
  const at = T0 / 1000 - 10 * 3600, flowFrom = T0 / 1000 - 2 * 3600;
  const known = new Map([[B, T0 - 24 * 3_600_000]]);
  r.knownFrom = id => known.get(id) ?? Infinity; r.knownKey = 'a';
  r.flowOf = id => id === O ? { buy: (a, z) => (z - a + 1) * 100, sell: () => 0, ownPrice: () => 69_000, span: { first: flowFrom, last: T0 / 1000 + 10 } } : undefined;
  const out = emptyBlock(2);
  r.read(at, 60, out, T0 + 3_600_000);
  assert.equal(out.unknown, false, 'Binance was recorded and loaded from 24 h back: its quiet minute is known');
  assert.equal(out.partial, true, 'OKX\'s flow begins at 2 h: its part of the block is missing');
  // A thin market's one stray second 23 h back, nothing known: no quiet hours claimed from it.
  known.clear(); r.knownKey = 'b';
  const stray = T0 / 1000 - 23 * 3600;
  r.flowOf = id => id === B ? { buy: (a, z) => (a <= stray && stray <= z ? 50 : 0), sell: () => 0, ownPrice: () => 69_000, span: { first: stray, last: stray } }
    : id === O ? { buy: (a, z) => (z - a + 1) * 100, sell: () => 0, ownPrice: () => 69_000, span: { first: flowFrom, last: T0 / 1000 + 10 } } : undefined;
  r.read(at, 60, out, T0 + 3_600_000);
  assert.equal(out.unknown, true, 'between the stray second and the loaded flow nothing is known');
});

test('the flow book holds what an answer reached, for every instrument asked (a quiet one too), through a broken stream; nothing for an empty answer', () => {
  const book = new FlowBook(), from = T0 - 24 * 3_600_000, t0 = T0 - 6 * 3_600_000;
  book.begin([B, O]);
  book.load({ from, to: T0, instruments: [{ id: B, t0, buy: new Float32Array([1, 2]), sell: new Float32Array([0, 0]) }, { id: O, t0: T0 - 3_600_000, buy: new Float32Array([1]), sell: new Float32Array([0]) }] }, [B, O], from);
  assert.equal(book.heldFrom(B), t0, 'asked from 24 h back, the answer reached 6 h: held from 6 h');
  assert.equal(book.heldFrom(O), t0, 'OKX first traded an hour back: quiet before, held as far as the answer reached');
  book.invalidate();
  assert.equal(book.heldFrom(B), t0, 'a broken stream asks again, but what was answered stays held meanwhile');
  book.begin([BS]);
  book.load({ from, to: T0, instruments: [] }, [BS], from);
  assert.equal(book.heldFrom(BS), Infinity, 'an answer that held nothing');
});

test('under a size floor the inspector\'s market rows add up to the block that holds the recording\'s end', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[B, T0 + 3_600_000, 70_000, 30_000]]), 1, 0);
  const { r } = reader(ring, { minUsd: 25_000, side: 'both', shown: () => true });
  const to = T0 + 30_000;
  r.recorded = { prints: [{ t: T0 + 10_000, id: B, side: 'buy', price: 69_000, usd: 40_000 }, { t: T0 + 33_000, id: O, side: 'sell', price: 69_000, usd: 90_000 }], from: T0, to, holes: [], minUsd: 25_000 };
  const out = emptyBlock(2);
  r.read(T0 / 1000, 60, out, T0 + 3_700_000);
  const rows = r.marketRows(T0 / 1000, 60), buy = rows.reduce((a, x) => a + x.buy, 0), sell = rows.reduce((a, x) => a + x.sell, 0);
  assert.equal(out.partial, true);
  assert.deepEqual([buy, sell], [out.buy, out.sell]);
});

test('a block read again is read from what it was while nothing it reads changed, and anew after any order counted into it', () => {
  const ring = new TapeRing(BLOCK), tally = new SecondTally(3600);
  ring.add(batch(1, [[B, T0, 70_000, 1_000]]), 1, 0);
  tally.reset(ring, all); while (tally.filling) tally.fill();
  const r = new BlockReader(); r.tally = tally; r.markets = [B, BS, O]; r.ref = B; r.setVenues(2, venueSlot);
  let seed = 3;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const out = emptyBlock(2), fresh = emptyBlock(2), now = T0 + 25_000;
  const sum = (b: typeof out): (number | boolean)[] => [b.buy, b.sell, b.n, b.topBuy.has ? b.topBuy.usd : 0, b.topSell.has ? b.topSell.usd : 0, b.refPx, b.refPrev, b.partial, b.vBuy[0]!, b.vSell[1]!];
  for (let step = 0; step < 400; step++) {
    // An order into the first 20 seconds (late ones too), then a few reads, some of a block that did not change.
    if (rand() < 0.6) {
      ring.add(batch(step + 2, [[rand() < 0.5 ? B : O, T0 + Math.floor(rand() * 20_000), 70_000 + Math.round(rand() * 10), (rand() < 0.5 ? 1 : -1) * Math.round(1 + rand() * 50_000)]]), 1, 0);
      tally.update();
    }
    const s = T0 / 1000 + Math.floor(rand() * 20), B2 = rand() < 0.8 ? 1 : 5;
    r.read(s, B2, out, now);
    const f = new BlockReader(); f.tally = tally; f.markets = r.markets; f.ref = B; f.setVenues(2, venueSlot);
    f.read(s, B2, fresh, now);
    assert.deepEqual(sum(out), sum(fresh), `step ${step}`);
  }
});

test('a block read again is read anew when the reference market\'s first order reaches the ring, outside the block\'s seconds (review r5)', () => {
  // Before it, the reference's price before a block comes from the flow; after it, from the tally (none there: no price).
  const ring = new TapeRing(BLOCK), tally = new SecondTally(3600);
  ring.add(batch(1, [[O, T0, 70_000, 1_000]]), 1, 0);
  tally.reset(ring, all); while (tally.filling) tally.fill();
  const startSec = T0 / 1000 - 3600;
  const flow: FlowLike = { buy: (a, z) => (z - a + 1) * 100, sell: (a, z) => (z - a + 1) * 10, ownPrice: () => 69_000, span: { first: startSec, last: startSec + 7200 } };
  const make = (): BlockReader => { const r = new BlockReader(); r.tally = tally; r.markets = [B, BS, O]; r.ref = B; r.flowOf = id => id === B ? flow : undefined; r.setVenues(2, venueSlot); return r; };
  const r = make(), out = emptyBlock(2), fresh = emptyBlock(2), now = T0 + 25_000, s = T0 / 1000 + 5;
  r.read(s, 1, out, now);
  assert.equal(out.refPrev, 69_000);
  ring.add(batch(2, [[B, T0 + 15_000, 70_100, 2_000]]), 1, 0); tally.update();
  r.read(s, 1, out, now); make().read(s, 1, fresh, now);
  assert.ok(Number.isNaN(fresh.refPrev));
  assert.ok(Number.isNaN(out.refPrev), 'the kept copy follows the reference into the ring');
});
