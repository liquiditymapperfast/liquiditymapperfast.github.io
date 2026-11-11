import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRows, blocksOf, buildProfile, editedWindows, hollowRows, ladder, letterOf, levelsOfProfile, rowChoices, trailingGaps, valueArea, withLive, type Block, type Peer } from '../src/app/tpo/model.ts';
import { TPO_DEFAULTS, blockMsOf, readTpo, withEdits, withRows } from '../src/app/tpo/settings.ts';
import type { CandleRow } from '../src/app/store.ts';
import { TPO_BTC_2026_09_28 } from './fixtures/tpo-btc-2026-09-28.mts';

const MIN = 60_000, HALF = 30 * MIN, DAY = 86_400_000;
const DAY0 = Date.UTC(2026, 8, 28), NOW = Date.UTC(2026, 8, 30);
const bars = (venue: string): CandleRow[] => TPO_BTC_2026_09_28[venue]!.map(r => r as unknown as CandleRow);
const win = { key: 'd', from: DAY0, to: DAY0 + DAY };
const blockMap = (bs: readonly Block[]): Map<number, Block> => new Map(bs.map(b => [b.t, b]));

test('a day of Binance BTC at $50 rows gives the calls study TPO-1 measured', () => {
  const blocks = blocksOf(bars('binance'), win.from, win.to, HALF, HALF, NOW);
  assert.equal(blocks.length, 48);
  const p = buildProfile(win, blocks, HALF, 50, 0.7, NOW)!;
  // Research_Results/tpo_agreement_20261110/days.json, BTC 2026-09-28, the chart market's own profile.
  assert.deepEqual({ poc: p.poc, vah: p.vah, val: p.val, top: p.top, bottom: p.bottom, sp: p.singles.length, lo: p.lo, hi: p.hi }, { poc: 1668, vah: 1673, val: 1654, top: 'tail', bottom: 'neither', sp: 0, lo: 1650, hi: 1699 });
  assert.equal(p.total, [...p.counts.values()].reduce((a, b) => a + b, 0));
  assert.equal(p.above + p.below + (p.counts.get(p.poc) ?? 0), p.total);
  assert.equal(p.developing, false);
  // As prices, as the Volume profile's levels are: the middle of the point of control's row, the value area's outer edges.
  assert.deepEqual(levelsOfProfile(p), { poc: 1668.5 * 50, vah: 1674 * 50, val: 1654 * 50 });
  // The initial balance is the first hour's range.
  const ib = blocks.slice(0, 2);
  assert.equal(p.ibh, Math.floor(Math.max(...ib.map(b => b.h)) / 50));
  assert.equal(p.ibl, Math.floor(Math.min(...ib.map(b => b.l)) / 50));
});

test('charted on Hyperliquid at $20 rows, the calls say how many grids agree and two rows stand hollow (the TPO-1 mock day)', () => {
  const R = 20, mine = blocksOf(bars('hyperliquid'), DAY0 - DAY, win.to, HALF, HALF, NOW);
  const peers: Peer[] = [];
  for (const venue of Object.keys(TPO_BTC_2026_09_28)) {
    if (venue === 'hyperliquid' || !TPO_BTC_2026_09_28[venue]!.length) continue;
    const theirs = blockMap(blocksOf(bars(venue), DAY0 - DAY, win.to, HALF, HALF, NOW)), gaps = trailingGaps(mine, theirs, HALF);
    peers.push({ blocks: theirs, gap: t => gaps.get(t) ?? 0 });
  }
  const day = mine.filter(b => b.t >= win.from);
  const hollow = new Map(day.map(b => [b.t, hollowRows(b, peers, R)]));
  const p = buildProfile(win, day, HALF, R, 0.7, NOW, hollow)!;
  assert.deepEqual([p.top, p.topVotes, p.bottom, p.bottomVotes], ['tail', 4, 'neither', 2]);
  assert.equal(p.blocks.reduce((n, b) => n + b.hollow.size, 0), 2);
  // The hollow rows are the 01:30 block's low, wholly under where most of the market stopped (83,582).
  const d = p.blocks.find(b => b.hollow.size)!;
  assert.equal(d.t, DAY0 + 3 * HALF);
  for (const r of d.hollow) assert.ok((r + 1) * R <= 83_582.5 && r >= d.a);
});

test('a market whose whole range moved is not hollow: only a widened range is a wick', () => {
  const peer = (h: number, l: number): Peer => ({ blocks: new Map([[0, { t: 0, h, l, o: l, c: h, usd: 100, closed: true }]]), gap: () => 0 });
  const peers = [peer(100.0, 99.0), peer(100.0, 99.0), peer(100.01, 99.0)];
  // A wick 10 bp over the others with the low where theirs is: hollow.
  assert.ok(hollowRows({ t: 0, h: 100.1, l: 99.0, o: 99, c: 100, usd: 50, closed: true }, peers, 0.01).size > 0);
  // The same high with the low 10 bp up too: the range moved (its gap changed), not a wick.
  assert.equal(hollowRows({ t: 0, h: 100.1, l: 99.1, o: 99.1, c: 100, usd: 50, closed: true }, peers, 0.01).size, 0);
  // Under 3 bp past the market: never hollow, however fine the rows.
  assert.equal(hollowRows({ t: 0, h: 100.02, l: 99.0, o: 99, c: 100, usd: 50, closed: true }, peers, 0.001).size, 0);
  // Fewer than three markets: nothing is judged.
  assert.equal(hollowRows({ t: 0, h: 101, l: 99, o: 99, c: 100, usd: 50, closed: true }, peers.slice(0, 1), 0.01).size, 0);
});

test('the point of control prefers the middle on a tie and the value area grows on the larger side', () => {
  const counts = new Map([[0, 1], [1, 3], [2, 2], [3, 3], [4, 1]]);
  const a = valueArea(counts, 0, 4, 0.7);
  assert.equal(a.poc, 1);   // rows 1 and 3 tie; both 1 from the middle (2): the lower
  assert.equal(a.total, 10);
  assert.ok(a.val <= a.poc && a.vah >= a.poc);
  let held = 0; for (let r = a.val; r <= a.vah; r++) held += counts.get(r) ?? 0;
  assert.ok(held >= 7);
});

test('blocks: a replay never reads a candle still forming at its moment, live does', () => {
  const rows: CandleRow[] = [[0, 10, 12, 9, 11, 1], [MIN * 5, 11, 15, 10, 14, 1]] as unknown as CandleRow[];
  const live = blocksOf(rows, 0, HALF, HALF, 5 * MIN, 7 * MIN);
  assert.equal(live[0]!.h, 15); assert.equal(live[0]!.closed, false); assert.equal(live[0]!.c, 14);
  const replay = blocksOf(rows, 0, HALF, HALF, 5 * MIN, 7 * MIN, true);
  assert.equal(replay[0]!.h, 12);
  // The chart's own fresher price widens the block under way only.
  assert.equal(withLive(live, HALF, { t: 8 * MIN, h: 16, l: 8, c: 15 })[0]!.h, 16);
  assert.equal(withLive(live, HALF, { t: HALF + MIN, h: 16, l: 8, c: 15 })[0]!.h, 15);
});

test('Auto rows come from the last complete days, so they do not move as history loads', () => {
  const days: CandleRow[] = [];
  for (let i = 0; i < 20; i++) days.push([DAY0 - (20 - i) * DAY, 100, 100 + (i % 3) * 10 + 90, 100, 150, 1] as unknown as CandleRow);
  const r = autoRows(days, DAY0, 'day');
  assert.equal(r, ladder(100 / 90));
  assert.equal(autoRows(days.slice(5), DAY0, 'day'), r);
  assert.equal(ladder(22.4), 20); assert.equal(ladder(0.906), 1); assert.equal(ladder(0.000249), 0.0002);
  assert.deepEqual(rowChoices(20), [5, 10, 20, 50, 100]);
});

test('letters run A to Z, a to z, then again', () => {
  assert.deepEqual([0, 25, 26, 47, 51, 52].map(letterOf), ['A', 'Z', 'a', 'v', 'z', 'A']);
});

test('splits cut a window at the block, merges join one to the window before it', () => {
  const ws = [{ key: 'a', from: 0, to: DAY }, { key: 'b', from: DAY, to: 2 * DAY }, { key: 'c', from: 2 * DAY, to: 3 * DAY }];
  const split = editedWindows(ws, [DAY + 7 * HALF + 5 * MIN], [], HALF);
  assert.deepEqual(split.map(w => [w.from, w.to]), [[0, DAY], [DAY, DAY + 7 * HALF], [DAY + 7 * HALF, 2 * DAY], [2 * DAY, 3 * DAY]]);
  const merged = editedWindows(ws, [], [2 * DAY], HALF);
  assert.deepEqual(merged.map(w => [w.from, w.to, w.base]), [[0, DAY, 'a'], [DAY, 3 * DAY, 'b']]);
  // A merge with nothing before it, or a split on a window's edge, changes nothing.
  assert.deepEqual(editedWindows(ws, [DAY], [0], HALF).map(w => w.key), ['a', 'b', 'c']);
});

test('settings read back field by field', () => {
  assert.deepEqual(readTpo(undefined), { ...TPO_DEFAULTS });
  const s = readTpo({ on: true, period: 'week', block: 240, count: 99, look: 'letters', colour: 'count', share: 68, rows: { BTC: 20, bad: 3, ETH: -1 }, splits: { BTC: [3, 1, 'x'] } });
  assert.equal(s.on, true); assert.equal(s.period, 'week'); assert.equal(s.block, 240); assert.equal(s.count, TPO_DEFAULTS.count);
  assert.equal(s.look, 'letters'); assert.equal(s.colour, 'count'); assert.equal(s.share, 68);
  assert.deepEqual(s.rows, { BTC: 20 }); assert.deepEqual(s.splits, { BTC: [1, 3] });
  assert.equal(blockMsOf({ block: 0, period: 'week' }), 240 * MIN); assert.equal(blockMsOf({ block: 0, period: 'day' }), HALF); assert.equal(blockMsOf({ block: 60, period: 'day' }), 60 * MIN);
  assert.deepEqual(withEdits(s, 'merges', 'BTC', l => [...l, 5]).merges, { BTC: [5] });
  assert.deepEqual(withEdits(withEdits(s, 'merges', 'BTC', l => [...l, 5]), 'merges', 'BTC', () => []).merges, {});
  assert.deepEqual(withRows(s, 'BTC', 0).rows, {}); assert.deepEqual(withRows(s, 'ETH', 2).rows, { BTC: 20, ETH: 2 });
});
