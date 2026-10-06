import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFamilies, familyKey } from '../src/app/cvd/families.ts';
import { Ranker, quiet, rankFamilies, type RankInput } from '../src/app/cvd/rank.ts';
import { PHI, locateRow, maxScroll, rowHeights } from '../src/app/cvd/layout.ts';
import { BURST_DEFAULTS, burst } from '../src/app/cvd/burst.ts';
import { FlowSeries } from '../src/shared/flow.ts';
import { PriceTrack } from '../src/app/cvd/price.ts';
import { defaultShow } from '../src/app/store.ts';

const kinds: Record<string, 'spot' | 'perp'> = { 'binance:BTCUSDT': 'perp', 'binancespot:BTCUSDT': 'spot', 'coinbase:BTC-USD': 'spot', 'hyperliquid:BTC-PERP': 'perp', 'okx:BTC-USDT-SWAP': 'perp', 'okx:BTC-USDT': 'spot', 'okx:BTC-USD-SWAP': 'perp' };
const kindOf = (id: string) => kinds[id] ?? null;

test('a venue and its spot twin are one family, and a market of unknown kind counts as a perpetual', () => {
  assert.equal(familyKey('binancespot'), 'binance'); assert.equal(familyKey('binance'), 'binance'); assert.equal(familyKey('binanceus'), 'binanceus');
  assert.equal(familyKey('spot'), 'spot', 'a name that is only "spot" is not cut to nothing');
  const families = buildFamilies(['binance:BTCUSDT', 'coinbase:BTC-USD', 'binancespot:BTCUSDT', 'mystery:X', 'okx:BTC-USDT-SWAP', 'okx:BTC-USDT', 'okx:BTC-USD-SWAP'], kindOf);
  assert.deepEqual(families.map(f => [f.key, f.lanes.map(l => `${l.kind}:${l.id}`)]), [
    ['binance', ['perp:binance:BTCUSDT', 'spot:binancespot:BTCUSDT']],
    ['coinbase', ['spot:coinbase:BTC-USD']],
    ['mystery', ['perp:mystery:X']],
    ['okx', ['perp:okx:BTC-USDT-SWAP', 'spot:okx:BTC-USDT']],            // the second perpetual is not a second lane
  ]);
});

const input = (key: string, spot: number, perp: number, quietNow = false): RankInput => ({ family: { key, lanes: [] }, spot, perp, quiet: quietNow });

test('ranking is by gross volume, strict about the count, and leaves out a family with no volume', () => {
  const ranked = rankFamilies([input('a', 10, 20), input('b', 0, 0), input('c', 100, 0), input('d', 5, 5), input('e', 1, 0)], { top: 3 });
  assert.deepEqual(ranked.map(r => r.family.key), ['c', 'a', 'd'], 'b has no volume and does not fill a place; e is fourth');
  assert.equal(rankFamilies([input('a', 1, 0), input('b', 0, 0)], { top: 6 }).length, 1, 'no filler rows up to N');
  assert.ok(Math.abs(ranked.reduce((s, r) => s + r.share, 0) - 140 / 141) < 1e-12, 'shares are of all volume, so the shown rows can add up to less than 1');
  assert.equal(rankFamilies([input('a', 1, 1), input('b', 3, 3)], { top: null }).length, 2);
});

test('a pinned family takes the last place when it is outside the top N, and the list stays N long', () => {
  const inputs = [input('a', 50, 0), input('b', 40, 0), input('c', 30, 0), input('hyperliquid', 1, 0)];
  assert.deepEqual(rankFamilies(inputs, { top: 3, pin: ['hyperliquid'] }).map(r => r.family.key), ['a', 'b', 'hyperliquid']);
  assert.deepEqual(rankFamilies(inputs, { top: 3, pin: ['a'] }).map(r => r.family.key), ['a', 'b', 'c'], 'already in');
  assert.deepEqual(rankFamilies(inputs, { top: 3, pin: ['nobody'] }).map(r => r.family.key), ['a', 'b', 'c']);
  assert.deepEqual(rankFamilies(inputs, { top: 3 }).map(r => r.family.key), ['a', 'b', 'c'], 'no pins');
});

test('any exchanges can be pinned: they displace the smallest of the rest, the order stays by volume, and the list stays N long', () => {
  const inputs = [input('a', 50, 0), input('b', 40, 0), input('c', 30, 0), input('d', 20, 0), input('e', 10, 0), input('f', 1, 0)];
  assert.deepEqual(rankFamilies(inputs, { top: 4, pin: ['e', 'f'] }).map(r => r.family.key), ['a', 'b', 'e', 'f'], 'two pins take the last two places');
  assert.deepEqual(rankFamilies(inputs, { top: 4, pin: ['f', 'a'] }).map(r => r.family.key), ['a', 'b', 'c', 'f'], 'a pin already in the top keeps its place and costs none');
  assert.deepEqual(rankFamilies(inputs, { top: 3, pin: ['f', 'e', 'd', 'c'] }).map(r => r.family.key), ['c', 'd', 'e'], 'more pins than places: the biggest pinned ones stay');
  assert.deepEqual(rankFamilies(inputs, { top: null, pin: ['f'] }).length, 6, 'with no limit everything shows');
  assert.deepEqual(rankFamilies([input('a', 5, 0), input('z', 0, 0)], { top: 3, pin: ['z'] }).map(r => r.family.key), ['a'], 'a pinned exchange with no volume has nothing to show');
});

test('the ranker holds the order for the refresh interval but shows current numbers, and drops a family that vanished', () => {
  const ranker = new Ranker(60_000, true);
  const first = rankFamilies([input('a', 10, 0), input('b', 5, 0)], { top: 6 });
  assert.deepEqual(ranker.apply(0, first).map(r => r.family.key), ['a', 'b']);
  const flipped = rankFamilies([input('a', 10, 0), input('b', 50, 0)], { top: 6 });
  const held = ranker.apply(30_000, flipped);
  assert.deepEqual(held.map(r => r.family.key), ['a', 'b'], 'the order is held');
  assert.equal(held[1]!.gross, 50, 'with the numbers of now');
  assert.deepEqual(ranker.apply(60_000, flipped).map(r => r.family.key), ['b', 'a'], 're-ranked when due');
  assert.deepEqual(ranker.apply(61_000, rankFamilies([input('b', 1, 0)], { top: 6 })).map(r => r.family.key), ['b'], 'a held family with no data is gone');
});

test('with auto off the first layout stays for good, until reset', () => {
  const ranker = new Ranker(1_000, false);
  ranker.apply(0, rankFamilies([input('a', 10, 0), input('b', 5, 0)], { top: 6 }));
  assert.deepEqual(ranker.apply(10_000_000, rankFamilies([input('a', 1, 0), input('b', 5, 0)], { top: 6 })).map(r => r.family.key), ['a', 'b']);
  ranker.reset();
  assert.deepEqual(ranker.apply(10_000_001, rankFamilies([input('a', 1, 0), input('b', 5, 0)], { top: 6 })).map(r => r.family.key), ['b', 'a']);
});

test('quiet means nothing traded in the last five completed minutes', () => {
  const now = Date.UTC(2026, 9, 6, 12, 7, 30);
  const seen: [number, number][] = [];
  assert.equal(quiet((a, b) => { seen.push([a, b]); return 0; }, now), true);
  assert.deepEqual(seen, [[Date.UTC(2026, 9, 6, 12, 2, 0) / 1000, Date.UTC(2026, 9, 6, 12, 6, 59) / 1000]], 'the five minutes before 12:07:00');
  assert.equal(quiet(() => 1, now), false);
});

// ---- Row heights ------------------------------------------------------------------------------------------------------------------

const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

test('golden heights taper by 1/φ per rank, the aggregate is the tallest, and everything fits when there is room', () => {
  const l = rowHeights('golden', 2_000, [0.4, 0.3, 0.2, 0.1], { minRow: 20, minAgg: 20, price: 40 });
  assert.ok(l.rows[0]! > l.rows[1]! && l.rows[1]! > l.rows[2]! && l.rows[2]! > l.rows[3]!);
  assert.ok(Math.abs(l.rows[0]! / l.rows[1]! - PHI) < 0.02 && Math.abs(l.rows[1]! / l.rows[2]! - PHI) < 0.02, `ratios ${l.rows.join(',')}`);
  assert.ok(l.agg > l.rows[0]!);
  assert.ok(Math.abs(l.content - 2_000) <= 3, 'the rows fill the room (rounding)');
  assert.equal(l.price, 40);
});

test('equal heights are equal, the aggregate is still bigger, and volume heights follow the shares with a floor', () => {
  const e = rowHeights('equal', 1_000, [0.5, 0.2, 0.1, 0.1], { minRow: 20, minAgg: 20 });
  assert.equal(new Set(e.rows).size, 1); assert.ok(e.agg > e.rows[0]!);
  const v = rowHeights('volume', 1_400, [0.6, 0.3, 0.1, 0.0], { minRow: 20, minAgg: 20, floor: 0.06 });
  assert.ok(v.rows[0]! > v.rows[1]! && v.rows[1]! > v.rows[2]! && v.rows[2]! > v.rows[3]!, v.rows.join(','));
  assert.ok(v.rows[3]! > 0, 'the floor keeps a row with no share alive');
  assert.ok(v.agg > v.rows[0]!);
});

test('rows never go below their minimum: what does not fit scrolls', () => {
  const l = rowHeights('golden', 500, [0.3, 0.2, 0.15, 0.1, 0.1, 0.05, 0.05, 0.05], { minRow: 54, minAgg: 84, price: 44 });
  assert.ok(l.rows.every(h => h >= 54), l.rows.join(','));
  assert.ok(l.agg >= 84 && l.agg > Math.max(...l.rows));
  assert.ok(l.content > 500, 'taller than the room, so the column scrolls');
  const roomy = rowHeights('equal', 5_000, [0.5, 0.5]);
  assert.ok(Math.abs(roomy.content - 5_000) <= 2);
});

test('no venue rows: the aggregate takes the room', () => {
  const l = rowHeights('golden', 600, []);
  assert.deepEqual(l.rows, []); assert.equal(l.price + l.agg, 600);
});

// ---- Bursts -----------------------------------------------------------------------------------------------------------------------

function quietSeries(nowSec: number, seconds: number, perSecond: [number, number]): FlowSeries {
  const s = new FlowSeries(); for (let i = seconds; i >= 0; i--) s.set(nowSec - i, perSecond[0], perSecond[1]); return s;
}
let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

test('a burst is a delta far outside what the venue normally does, and big enough to matter', () => {
  const now = 2_000_000, s = new FlowSeries();
  for (let i = 3_000; i >= 0; i--) s.set(now - i, 20_000 + Math.round(rnd() * 20_000), 20_000 + Math.round(rnd() * 20_000)); // noisy, balanced
  assert.equal(burst(s, now), null, 'normal flow is not a burst');
  for (let i = 0; i < 10; i++) s.set(now - i, 400_000, 20_000);                         // 10 s of heavy buying: about 3.8 M of delta
  const found = burst(s, now)!;
  assert.ok(found && found.delta > 3_000_000 && found.z > 4, JSON.stringify(found));
  assert.equal(burst(s, now, { ...BURST_DEFAULTS, minUsd: 10_000_000 }), null, 'too small for the floor');
  assert.equal(burst(s, now, { ...BURST_DEFAULTS, k: 1_000 }), null, 'not unusual enough');
});

test('selling bursts are negative, a short history says nothing, and a stale series says nothing', () => {
  const now = 2_000_000, s = quietSeries(now, 3_000, [30_000, 30_000]);
  for (let i = 0; i < 10; i++) s.set(now - i, 10_000, 600_000);
  const down = burst(s, now)!;
  assert.ok(down.delta < -5_000_000 && down.z < -4);
  const young = quietSeries(now, 60, [1_000, 1_000]); for (let i = 0; i < 10; i++) young.set(now - i, 9_000_000, 0);
  assert.equal(burst(young, now), null, 'fewer than 12 baseline windows');
  assert.equal(burst(s, now + 120), null, 'nothing for two minutes: not news');
  assert.equal(burst(new FlowSeries(), now), null);
});

test('a baseline with no variation at all is judged by the minimum alone, with an infinite z', () => {
  const now = 2_000_000, s = quietSeries(now, 3_000, [10_000, 10_000]);
  for (let i = 0; i < 10; i++) s.set(now - i, 500_000, 0);
  const found = burst(s, now)!;
  assert.ok(found && found.z === Infinity && sum([found.delta]) > 4_000_000);
});

test('hit testing: the aggregate and the price strip stay put, the venue rows scroll beneath them and are clipped', () => {
  const l = rowHeights('equal', 400, [0.4, 0.3, 0.3, 0.2, 0.2], { minRow: 60, minAgg: 90, price: 40 });
  assert.ok(l.content > 400, 'five rows of 60 do not fit');
  assert.deepEqual(locateRow(l, 0, 400, 10), { kind: 'agg' });
  assert.deepEqual(locateRow(l, 0, 400, l.agg + 5), { kind: 'price' });
  assert.deepEqual(locateRow(l, 0, 400, l.agg + l.price + 5), { kind: 'row', index: 0 });
  assert.deepEqual(locateRow(l, 70, 400, l.agg + l.price + 5), { kind: 'row', index: 1 }, 'scrolled by more than a row: the second row is under the strip');
  assert.deepEqual(locateRow(l, 70, 400, 10), { kind: 'agg' }, 'scrolling does not move the aggregate');
  assert.equal(locateRow(l, 0, 400, 400), null); assert.equal(locateRow(l, 0, 400, -1), null);
  assert.equal(maxScroll(l, 400), l.content - 400);
  assert.equal(maxScroll(rowHeights('equal', 2_000, [0.5]), 2_000), 0);
  const last = maxScroll(l, 400);
  assert.deepEqual(locateRow(l, last, 400, 399), { kind: 'row', index: 4 }, 'scrolled to the end, the last row is at the bottom');
});

test('the price track follows candle closes, then marks, and a column holds the last price at its end', () => {
  const T = 1_800_000_000_000, track = new PriceTrack();
  track.load([[T, 100, 101, 99, 100.5], [T + 60_000, 100.5, 103, 100, 102], [T + 120_000, 102, 104, 101, 103.5]], T + 150_000);
  assert.equal(track.at(T + 59_999), 100.5); assert.equal(track.at(T + 119_999), 102); assert.ok(Number.isNaN(track.at(T - 1)));
  assert.equal(track.at(T + 150_000), 103.5, 'the minute still open is a price at now, not at its end');
  track.add(T + 151_000, 104); track.add(T + 151_400, 104.2); track.add(T + 140_000, 50); track.add(T + 152_000, NaN); track.add(T + 153_000, 0);
  assert.equal(track.length, 4, 'one mark a second; an old or invalid one is ignored');
  assert.equal(track.at(T + 152_000), 104.2);
  const cols = track.columns(T, T + 180_000, 6);
  assert.deepEqual([...cols.last].map(v => Number.isNaN(v) ? 'none' : v), ['none', 100.5, 100.5, 102, 102, 104.2], 'a candle is a price at its close, so the first 30 s has none');
  assert.equal(cols.min, 100.5); assert.equal(cols.max, 104.2);
  track.load([[T + 180_000, 90, 91, 89, 90.5]], T + 240_000);
  assert.equal(track.at(T + 239_999), 90.5, 'history replaced; marks newer than its last candle would stay');
  assert.ok(Number.isNaN(new PriceTrack().columns(0, 10, 2).min));
});

test('a first visit starts with the flow column on a wide window or a phone (which has a tab), and without it on a medium one', () => {
  assert.deepEqual([390, 640, 820, 1180, 1499, 1500, 1920, 3440].map(w => defaultShow(w).cvd), [true, true, false, false, false, true, true, true]);
  assert.ok([390, 1180, 1920].every(w => defaultShow(w).book), 'the book is on everywhere');
});
