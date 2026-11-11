import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TPO_ROWS, autoRows, blocksOf, buildProfile, editedWindows, hollowRows, ibBlocksOf, ladder, letterOf, levelsOfProfile, rowChoices, trailingGaps, valueArea, withLive, type Block, type Peer } from '../src/app/tpo/model.ts';
import { TPO_DEFAULTS, blockMsOf, editScope, readTpo, withEdits, withRows } from '../src/app/tpo/settings.ts';
import { barFor } from '../src/app/tpo/layer.ts';
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
  assert.equal(withLive(live, HALF, { t: 0, h: 16, l: 8, c: 15 })[0]!.h, 16);
  assert.equal(withLive(live, HALF, { t: HALF, h: 16, l: 8, c: 15 })[0]!.h, 15);
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

test('splits cut one calendar window at the block, merges join a window to the one that ends where it begins', () => {
  const ws = [{ key: 'a', from: 0, to: DAY }, { key: 'b', from: DAY, to: 2 * DAY }, { key: 'c', from: 2 * DAY, to: 3 * DAY }];
  const split = editedWindows(ws, [`${DAY + 7 * HALF + 5 * MIN}@b`], [], HALF);
  assert.deepEqual(split.map(w => [w.from, w.to, w.base]), [[0, DAY, 'a'], [DAY, DAY + 7 * HALF, 'b'], [DAY + 7 * HALF, 2 * DAY, 'b'], [2 * DAY, 3 * DAY, 'c']]);
  const merged = editedWindows(ws, [], ['c'], HALF);
  assert.deepEqual(merged.map(w => [w.from, w.to, w.base, w.members.join()]), [[0, DAY, 'a', 'a'], [DAY, 3 * DAY, 'b', 'b,c']]);
  // A split names its window: a moment inside another window, or on a window's edge, cuts nothing; a merge with nothing before it does nothing.
  assert.deepEqual(editedWindows(ws, [`${DAY + HALF}@a`, `${DAY}@b`], ['a'], HALF).map(w => w.key), ['a', 'b', 'c']);
  // Overlapping windows (two sessions) never merge: none ends where the other begins.
  const sessions = [{ key: 'L', from: 7 * HALF * 2, to: 16 * HALF * 2 }, { key: 'N', from: 13 * HALF * 2, to: 22 * HALF * 2 }];
  assert.deepEqual(editedWindows(sessions, [`${14 * HALF * 2}@N`], ['N'], HALF).map(w => [w.from, w.to, w.base]), [[7 * HALF * 2, 16 * HALF * 2, 'L'], [13 * HALF * 2, 14 * HALF * 2, 'N'], [14 * HALF * 2, 22 * HALF * 2, 'N']]);
});

test('settings read back field by field; edits are kept per coin, kind of window and block length', () => {
  assert.deepEqual(readTpo(undefined), { ...TPO_DEFAULTS });
  const scope = editScope('BTC', 'day', HALF);
  assert.equal(scope, 'BTC|day|30');
  const s = readTpo({ on: true, period: 'week', block: 240, count: 99, look: 'letters', colour: 'count', share: 68, rows: { BTC: 20, bad: 3, ETH: -1, PEPE: 1e-13 }, splits: { [scope]: ['1794000000000@k', 'x', 3], BTC: ['1794000000000@k'] }, merges: { [scope]: ['k'] } });
  assert.equal(s.on, true); assert.equal(s.period, 'week'); assert.equal(s.block, 240); assert.equal(s.count, TPO_DEFAULTS.count);
  assert.equal(s.look, 'letters'); assert.equal(s.colour, 'count'); assert.equal(s.share, 68);
  assert.deepEqual(s.rows, { BTC: 20 }); assert.deepEqual(s.splits, { [scope]: ['1794000000000@k'] }); assert.deepEqual(s.merges, { [scope]: ['k'] });
  assert.equal(blockMsOf({ block: 0, period: 'week' }), 240 * MIN); assert.equal(blockMsOf({ block: 0, period: 'day' }), HALF); assert.equal(blockMsOf({ block: 60, period: 'day' }), 60 * MIN);
  assert.deepEqual(withEdits(s, 'merges', scope, () => []).merges, {});
  assert.deepEqual(withEdits(s, 'merges', 'ETH|day|30', l => [...l, 'q']).merges, { [scope]: ['k'], 'ETH|day|30': ['q'] });
  assert.deepEqual(withRows(s, 'BTC', 0).rows, {}); assert.deepEqual(withRows(s, 'ETH', 2).rows, { BTC: 20, ETH: 2 });
});

test('the value area does not take a row more for a share that comes out a hair over a whole count', () => {
  // 68 % of 75 is 51, which binary arithmetic makes 51.00000000000001.
  const counts = new Map<number, number>(); for (let r = 0; r < 15; r++) counts.set(r, 5);
  const a = valueArea(counts, 0, 14, 0.68);
  let held = 0; for (let r = a.val; r <= a.vah; r++) held += counts.get(r) ?? 0;
  assert.ok(held >= 51 && held < 56, `held ${held}`);
});

test('the initial balance is the first hour of blocks, at least one', () => {
  assert.deepEqual([15, 30, 60, 240].map(m => ibBlocksOf(m * MIN)), [4, 2, 1, 1]);
  const rows: CandleRow[] = [];
  for (let i = 0; i < 8; i++) rows.push([i * 15 * MIN, 100, 101 + i, 99 - i, 100, 1] as unknown as CandleRow);
  const p = buildProfile({ key: 'w', from: 0, to: DAY }, blocksOf(rows, 0, DAY, 15 * MIN, 15 * MIN, DAY), 15 * MIN, 1, 0.7, DAY)!;
  assert.equal(p.ibBlocks, 4); assert.equal(p.ibh, 104); assert.equal(p.ibl, 96);
});

test('rows far finer than the prices make no profile, quickly, instead of millions of rows', () => {
  const block: Block = { t: 0, h: 80_010, l: 80_000, o: 80_000, c: 80_005, usd: 1, closed: true };
  const started = Date.now();
  assert.equal(buildProfile({ key: 'w', from: 0, to: DAY }, [block], HALF, 1e-9, 0.7, DAY), null);
  assert.equal(buildProfile({ key: 'w', from: 0, to: DAY }, [block], HALF, 10 / (MAX_TPO_ROWS + 10), 0.7, DAY), null);
  assert.ok(Date.now() - started < 100);
});

test('the chart\'s own price starts the block under way where the history has not reached it, on the window\'s grid', () => {
  const rows: CandleRow[] = [[0, 10, 12, 9, 11, 1]] as unknown as CandleRow[];
  const blocks = blocksOf(rows, 0, DAY, HALF, HALF, HALF + MIN);
  const next = withLive(blocks, HALF, { t: HALF, h: 13, l: 10.5, c: 12 });
  assert.deepEqual(next.map(b => [b.t, b.h, b.l, b.closed]), [[0, 12, 9, true], [HALF, 13, 10.5, false]]);
  // A block on a grid that starts off the half hour: the window's own, not the clock's.
  const off = blocksOf([[20 * MIN, 1, 2, 0.5, 1.5, 1]] as unknown as CandleRow[], 10 * MIN, DAY, HALF, 5 * MIN, DAY);
  assert.equal(off[0]!.t, 10 * MIN);
});

test('the usual gap is the median of the day before, the same as worked out one block at a time', () => {
  const mine: Block[] = [], theirs = new Map<number, Block>();
  for (let i = 0; i < 200; i++) {
    const t = i * HALF, c = 100 + Math.sin(i) * 3;
    mine.push({ t, h: c, l: c, o: c, c, usd: 1, closed: true });
    theirs.set(t, { t, h: c, l: c, o: c, c: c * (1 + ((i * 7919) % 13 - 6) / 1e4), usd: 1, closed: true });
  }
  const fast = trailingGaps(mine, theirs, HALF);
  for (const i of [0, 10, 24, 47, 48, 49, 120, 199]) {
    const t = i * HALF, prev = mine.filter(b => b.t < t && b.t >= t - DAY).map(b => 1e4 * Math.log(theirs.get(b.t)!.c / b.c)).sort((a, b) => a - b), n = prev.length;
    const want = n >= 24 ? (n % 2 ? prev[n >> 1]! : (prev[n / 2 - 1]! + prev[n / 2]!) / 2) : 0;
    assert.ok(Math.abs(fast.get(t)! - want) < 1e-9, `block ${i}`);
  }
});

test('a peer whose history stops inside a block does not judge it', () => {
  const peer = (h: number, l: number, heldTo = Infinity): Peer => ({ blocks: new Map([[0, { t: 0, h, l, o: l, c: h, usd: 100, closed: true }]]), gap: () => 0, heldTo });
  const wick: Block = { t: 0, h: 100.1, l: 99.0, o: 99, c: 100, usd: 50, closed: true };
  assert.ok(hollowRows(wick, [peer(100, 99), peer(100, 99), peer(100.01, 99)], 0.01, HALF).size > 0);
  // Two of the three read before the block ended: fewer than three markets judge it, so nothing is hollow.
  assert.equal(hollowRows(wick, [peer(100, 99, HALF / 2), peer(100, 99, HALF / 2), peer(100.01, 99)], 0.01, HALF).size, 0);
});

test('the candle size fits every window of the calendar, both daylight-saving offsets', () => {
  assert.equal(barFor(240 * MIN, [{ from: 0, to: DAY }]), 240 * MIN);
  // Madrid's midnight is 23:00 or 22:00 UTC: four-hour blocks are built from hours.
  assert.equal(barFor(240 * MIN, [{ from: -60 * MIN, to: DAY - 60 * MIN }, { from: -120 * MIN, to: DAY - 120 * MIN }]), 60 * MIN);
  // A session starting at :15 needs quarter hours.
  assert.equal(barFor(HALF, [{ from: 15 * MIN, to: 4 * HALF + 15 * MIN }]), 15 * MIN);
});

test('rows too fine to count give no profile and no hollow rows, without looping (review r2)', () => {
  const started = Date.now();
  const flat: Block = { t: 0, h: 80_000, l: 80_000, o: 80_000, c: 80_000, usd: 1, closed: true };
  // Past 2^53 a row and the next are one number: refused. Below it a flat block is one row, worked out at once.
  assert.equal(buildProfile({ key: 'w', from: 0, to: DAY }, [flat], HALF, 1e-12, 0.7, DAY), null);
  for (const R of [1e-11, 1e-9]) assert.equal(buildProfile({ key: 'w', from: 0, to: DAY }, [flat], HALF, R, 0.7, DAY)?.total ?? 1, 1);
  const peer = (h: number, l: number): Peer => ({ blocks: new Map([[0, { t: 0, h, l, o: l, c: h, usd: 100, closed: true }]]), gap: () => 0 });
  const wick: Block = { t: 0, h: 80_320, l: 80_000, o: 80_000, c: 80_100, usd: 50, closed: true };
  assert.equal(hollowRows(wick, [peer(80_010, 80_000), peer(80_010, 80_000), peer(80_012, 80_000)], 1e-5, HALF).size, 0);
  assert.ok(hollowRows(wick, [peer(80_010, 80_000), peer(80_010, 80_000), peer(80_012, 80_000)], 10, HALF).size > 0);
  assert.ok(Date.now() - started < 200);
});

test('a split inside a merged window cuts the member it names; the window keeps every member\'s span', () => {
  const ws = [{ key: 'a', from: 0, to: DAY }, { key: 'b', from: DAY, to: 2 * DAY }];
  const merged = editedWindows(ws, [], ['b'], HALF);
  assert.deepEqual(merged[0]!.spans.map(x => [x.key, x.from, x.to]), [['a', 0, DAY], ['b', DAY, 2 * DAY]]);
  // Merged a+b, then cut at 14:00 of b: the cut names b (the member holding the moment), so the result is a+b's first part and the rest of b.
  const cut = editedWindows(ws, [`${DAY + 28 * HALF}@b`], ['b'], HALF);
  assert.deepEqual(cut.map(w => [w.from, w.to]), [[0, DAY + 28 * HALF], [DAY + 28 * HALF, 2 * DAY]]);
  // The same cut named after the first member cuts nothing (what the menu did before it looked the member up).
  assert.deepEqual(editedWindows(ws, [`${DAY + 28 * HALF}@a`], ['b'], HALF).map(w => [w.from, w.to]), [[0, 2 * DAY]]);
});
