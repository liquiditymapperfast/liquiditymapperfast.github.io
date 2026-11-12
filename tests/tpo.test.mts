import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TPO_ROWS, autoRows, blocksOf, buildProfile, editedWindows, hollowRows, ibBlocksOf, ladder, letterOf, levelsOfProfile, mergeBlocks, rowChoices, trailingGaps, valueArea, withLive, type Block, type Part, type Peer } from '../src/app/tpo/model.ts';
import { TPO_DEFAULTS, blockMsOf, editScope, readTpo, withEdits, withRows } from '../src/app/tpo/settings.ts';
import { barFor } from '../src/app/tpo/layer.ts';
import { paintTpo } from '../src/app/tpo/paint.ts';
import { View } from '../src/app/view.ts';
import { PALETTES } from '../src/app/theme.ts';
import { LabelBoard } from '../src/app/labels.ts';
import { rowOf } from '../src/shared/profile.ts';
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

// --- Candles from chosen markets, every window in view, the compact look (2026-11-11) ---

const part = (id: string, blocks: Block[], gap = 0, heldTo = Infinity): Part => ({ id, blocks: blockMap(blocks), gap: () => gap, heldTo });
const blk = (t: number, h: number, l: number, usd: number, o = l, c = h): Block => ({ t, h, l, o, c, usd, closed: true });

test('one chosen market alone gives its own blocks back', () => {
  const mine = blocksOf(bars('binance'), win.from, win.to, HALF, HALF, NOW);
  const merged = mergeBlocks([part('binance:BTCUSDT', mine)], 'binance:BTCUSDT', win.from, win.to, HALF, 50, NOW, true);
  assert.deepEqual(merged.map(b => [b.t, b.h, b.l, b.o, b.c, b.usd]), mine.map(b => [b.t, b.h, b.l, b.o, b.c, b.usd]));
  assert.ok(merged.every(b => b.xh === undefined && b.xl === undefined));
});

test('a block of chosen markets spans where most of their volume reached; a lone wick is drawn hollow and named, never counted', () => {
  // Three markets: two agree on 100-101, the smallest wicks 30 bp over them.
  const t0 = 0, parts = [part('a', [blk(t0, 101, 100, 600)]), part('b', [blk(t0, 101, 100, 300)]), part('c', [blk(t0, 101.3, 100, 100)])];
  const [m] = mergeBlocks(parts, 'a', 0, HALF, HALF, 0.1, NOW, true);
  assert.equal(m!.h, 101); assert.equal(m!.l, 100); assert.equal(m!.usd, 1000);
  assert.equal(m!.xh, 101.3); assert.equal(m!.up!.id, 'c'); assert.ok(Math.abs(m!.up!.bp - 1e4 * Math.log(101.3 / 101)) < 1e-9);
  // Drawn up to the wick, hollow there; counted as if the wick were not there at all.
  const withWick = buildProfile({ key: 'w', from: 0, to: HALF }, [m!], HALF, 0.1, 0.7, NOW)!;
  const without = buildProfile({ key: 'w', from: 0, to: HALF }, [{ ...m!, xh: undefined, up: undefined }], HALF, 0.1, 0.7, NOW)!;
  assert.equal(withWick.drawHi, rowOf(101.3, 0.1)); assert.equal(withWick.hi, without.hi);
  assert.deepEqual([withWick.poc, withWick.vah, withWick.val, withWick.top, withWick.topVotes, withWick.total], [without.poc, without.vah, without.val, without.top, without.topVotes, without.total]);
  const b = withWick.blocks[0]!;
  assert.ok(b.rz > b.z && b.hollow.size === b.rz - b.z && [...b.hollow].every(r => r > b.z));
  assert.equal(b.up!.id, 'c');
  // Off, the block is the body alone.
  const [plain] = mergeBlocks(parts, 'a', 0, HALF, HALF, 0.1, NOW, false);
  assert.equal(plain!.xh, undefined);
});

test('chosen markets: the larger volume decides, a moved range is no wick, two markets judge nothing, a market is moved by its gap first', () => {
  // The largest market holds more than half the volume: its range is the block's.
  const big = mergeBlocks([part('a', [blk(0, 102, 100, 700)]), part('b', [blk(0, 101, 99, 200)]), part('c', [blk(0, 101, 99, 100)])], 'a', 0, HALF, HALF, 0.1, NOW, true)[0]!;
  assert.deepEqual([big.h, big.l], [102, 100]);
  // A market whose whole range sits 30 bp higher moved (its gap changed): not hollow.
  const moved = mergeBlocks([part('a', [blk(0, 101, 100, 400)]), part('b', [blk(0, 101, 100, 400)]), part('c', [blk(0, 101.3, 100.3, 200)])], 'a', 0, HALF, HALF, 0.1, NOW, true)[0]!;
  assert.equal(moved.xh, undefined);
  // Two markets: no hollow, however far one wick goes.
  const two = mergeBlocks([part('a', [blk(0, 101, 100, 600)]), part('b', [blk(0, 103, 100, 400)])], 'a', 0, HALF, HALF, 0.1, NOW, true)[0]!;
  assert.equal(two.xh, undefined); assert.equal(two.h, 101);
  // A market 50 bp over the chart market as usual is moved down by that before it is weighed: no wick left.
  const gap = 1e4 * Math.log(101.505 / 101);
  const shifted = mergeBlocks([part('a', [blk(0, 101, 100, 400)]), part('b', [blk(0, 101, 100, 400)]), part('c', [blk(0, 101.505, 100.5, 200)], gap)], 'a', 0, HALF, HALF, 0.1, NOW, true)[0]!;
  assert.equal(shifted.xh, undefined); assert.ok(Math.abs(shifted.h - 101) < 1e-9);
  // A block a market has not read to its end is not judged until ten minutes after it ends.
  const parts = [part('a', [blk(0, 101, 100, 600)]), part('b', [blk(0, 101, 100, 300)]), part('c', [blk(0, 101.3, 100, 100)], 0, HALF - MIN)];
  assert.equal(mergeBlocks(parts, 'a', 0, HALF, HALF, 0.1, HALF + 5 * MIN, true)[0]!.xh, undefined);
  assert.equal(mergeBlocks(parts, 'a', 0, HALF, HALF, 0.1, HALF + 10 * MIN, true)[0]!.xh, 101.3);
  // The open and close are the chart market's where it is among them, else the largest's; a market with no block is left out.
  const oc = mergeBlocks([part('a', [blk(0, 101, 100, 100, 100.2, 100.8)]), part('b', [blk(0, 101, 100, 900, 100.4, 100.6)]), part('c', [])], 'a', 0, HALF, HALF, 0.1, NOW, true)[0]!;
  assert.deepEqual([oc.o, oc.c, oc.usd], [100.2, 100.8, 1000]);
  assert.deepEqual([mergeBlocks([part('b', [blk(0, 101, 100, 900, 100.4, 100.6)]), part('d', [blk(0, 101, 100, 100, 100.1, 100.9)])], null, 0, HALF, HALF, 0.1, NOW, true)[0]!.o], [100.4]);
});

test('blocks read only the bars inside the window, as quickly at the end of a long history as at its start', () => {
  const long: CandleRow[] = [];
  for (let i = 0; i < 20_000; i++) long.push([i * HALF, 100, 101 + (i % 7), 99 - (i % 5), 100, 1] as unknown as CandleRow);
  const from = 19_000 * HALF, to = from + DAY;
  const fast = blocksOf(long, from, to, HALF, HALF, Infinity);
  const slow = blocksOf(long.filter(b => b[0] >= from && b[0] < to), from, to, HALF, HALF, Infinity);
  assert.deepEqual(fast, slow); assert.equal(fast.length, 48);
});

test('settings: candles from chosen markets, every window in view by default, an old default of five read as every window in view', () => {
  assert.equal(TPO_DEFAULTS.count, 0); assert.equal(TPO_DEFAULTS.source, 'chart');
  const read = readTpo({ source: 'chosen', picks: ['binance/perp', 'nowhere/perp', 'binance/perp', 'coinbase/spot'], count: 0 });
  assert.equal(read.source, 'chosen'); assert.deepEqual(read.picks, ['binance/perp', 'coinbase/spot']); assert.equal(read.count, 0);
  // Saved before revision 2 a count of five was the default: every window in view now. Saved since, or any other count, is kept.
  assert.equal(readTpo({ count: 5 }).count, 0);
  assert.equal(readTpo({ count: 5, v: 2 }).count, 5);
  assert.equal(readTpo({ count: 7 }).count, 7);
  assert.equal(readTpo({ source: 'nonsense' }).source, 'chart');
  assert.equal(readTpo(readTpo({ count: 5, v: 2 })).count, 5);
});

test('Auto rows read up to an earlier day come from the days before it', () => {
  const days: CandleRow[] = [];
  // Ranges of 900 for the first 30 days, 90 for the 30 after.
  for (let i = 0; i < 60; i++) days.push([DAY0 + i * DAY, 1000, 1000 + (i < 30 ? 900 : 90), 1000, 1000, 1] as unknown as CandleRow);
  assert.equal(autoRows(days, DAY0 + 30 * DAY, 'day'), ladder(900 / 90));
  assert.equal(autoRows(days, DAY0 + 60 * DAY, 'day'), ladder(90 / 90));
});

/** A canvas that counts what is drawn. */
/** A canvas that counts what is drawn: rectangles (filled one by one, or added to a path), fills, strokes. */
function countingCanvas(): { ctx: CanvasRenderingContext2D; rects: number; fills: number; strokes: number } {
  const out = { rects: 0, fills: 0, strokes: 0, ctx: null as unknown as CanvasRenderingContext2D };
  const noop = (): void => {};
  out.ctx = new Proxy({}, {
    get: (_t, k) => k === 'fillRect' ? () => { out.rects++; out.fills++; } : k === 'rect' ? () => { out.rects++; } : k === 'fill' ? () => { out.fills++; } : k === 'strokeRect' || k === 'stroke' ? () => { out.strokes++; } : k === 'measureText' ? () => ({ width: 10 }) : noop,
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return out;
}

test('zoomed out, a profile is drawn compact: one bar a pixel row, no outline, the point of control still there', () => {
  const blocks = blocksOf(bars('binance'), win.from, win.to, HALF, HALF, NOW);
  const p = buildProfile(win, blocks, HALF, 5, 0.7, NOW)!;
  const rows = p.drawHi - p.drawLo + 1;
  // Two days on 600 px and BTC's range on 300 px: blocks under a pixel wide, rows under a pixel tall.
  const view = new View({ t0: win.from, t1: win.from + 2 * DAY, p0: p.low - 200, p1: p.high + 200 });
  const c = countingCanvas();
  const geos = paintTpo(c.ctx, { profiles: [p], settings: { ...TPO_DEFAULTS, on: true }, view, pw: 600, ph: 300, p: PALETTES.dark!, labels: new LabelBoard(), fold: 0, rank: () => 0, name: () => 'Sep 28', now: NOW, linesFor: () => false });
  assert.equal(geos.length, 1); assert.ok(geos[0]!.compact);
  const rowsPx = Math.ceil(((p.high + 5) - p.low) / (view.p1 - view.p0) * 300) + 2;
  // Backing and bar per pixel row (no cell per block and row), under the rows the profile spans.
  assert.ok(c.rects <= 2 * rowsPx + 4, `${c.rects} rects for ${rowsPx} pixel rows (${rows} rows)`);
  assert.ok(c.rects >= 2 * Math.floor(rowsPx / 2));
  // Gathered by colour: a fill for the backing and one for each colour and alpha, not one a bar (the 48 time colours at two alphas at most).
  assert.ok(c.fills <= 1 + 2 * 48 + 2, `${c.fills} fills`);
  // Its point of control drawn across the window (the Volume profile's lines do not stand for it here).
  assert.ok(c.strokes >= 1);
  // Laid out in time: one bar a block, not a cell a row.
  const u = countingCanvas();
  paintTpo(u.ctx, { profiles: [p], settings: { ...TPO_DEFAULTS, on: true, unfold: true }, view, pw: 600, ph: 300, p: PALETTES.dark!, labels: new LabelBoard(), fold: 1, rank: () => 0, name: () => '', now: NOW, linesFor: () => true });
  assert.equal(u.rects, 2 * p.blocks.length + 1);   // and the plot's clip
  assert.ok(u.fills <= 1 + p.blocks.length);
});

test('zoomed out to months, a profile narrower than 3 px is a strip: its range, value area and point of control, a few rectangles', () => {
  const blocks = blocksOf(bars('binance'), win.from, win.to, HALF, HALF, NOW);
  const p = buildProfile(win, blocks, HALF, 5, 0.7, NOW)!;
  const view = new View({ t0: win.from - 200 * DAY, t1: win.from + 2 * DAY, p0: p.low - 2_000, p1: p.high + 2_000 });
  const c = countingCanvas();
  const geos = paintTpo(c.ctx, { profiles: [p], settings: { ...TPO_DEFAULTS, on: true }, view, pw: 600, ph: 300, p: PALETTES.dark!, labels: new LabelBoard(), fold: 0, rank: () => 0, name: () => '', now: NOW, linesFor: () => true });
  assert.ok(geos[0]!.compact);
  // The plot's clip, the backing, the range, the value area, the stripe.
  assert.equal(c.rects, 5);
});

/** A canvas that records each fill in order: its colour, its alpha and the rectangles of its path (or the one of a fillRect). */
function recordingCanvas(): { ctx: CanvasRenderingContext2D; fills: { style: string; alpha: number; rects: number[][] }[] } {
  const out = { fills: [] as { style: string; alpha: number; rects: number[][] }[], ctx: null as unknown as CanvasRenderingContext2D };
  const state: Record<string, unknown> = { fillStyle: '', globalAlpha: 1 };
  let path: number[][] = [];
  const noop = (): void => {};
  out.ctx = new Proxy({}, {
    get: (_t, k) => k === 'beginPath' ? () => { path = []; } : k === 'rect' ? (...r: number[]) => { path.push(r); }
      : k === 'fill' ? () => { out.fills.push({ style: String(state.fillStyle), alpha: Number(state.globalAlpha), rects: path }); }
      : k === 'fillRect' ? (...r: number[]) => { out.fills.push({ style: String(state.fillStyle), alpha: Number(state.globalAlpha), rects: [r] }); }
      : k === 'measureText' ? () => ({ width: 10 }) : typeof k === 'string' && k in state ? state[k] : noop,
    set: (_t, k, v) => { state[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return out;
}

test('zoomed out, the compact profiles stand on a casing of the page colour a pixel round each bar, laid under all of them first', () => {
  const day1 = buildProfile(win, blocksOf(bars('binance'), win.from, win.to, HALF, HALF, NOW), HALF, 5, 0.7, NOW)!;
  // The next day: the same candles a day later and $400 higher, so its strip stands beside the first one's and overlaps its prices.
  const later = bars('binance').map(r => { const c = [...r] as unknown as number[]; c[0]! += DAY; for (const i of [1, 2, 3, 4]) c[i]! += 400; return c as unknown as CandleRow; });
  const win2 = { key: 'd2', from: DAY0 + DAY, to: DAY0 + 2 * DAY };
  const day2 = buildProfile(win2, blocksOf(later, win2.from, win2.to, HALF, HALF, NOW + DAY), HALF, 5, 0.7, NOW + DAY)!;
  for (const [palette, label] of [[PALETTES.dark!, 'dark'], [PALETTES.latte!, 'latte']] as const) {
    // Two hundred days on 600 px: each day 3 px wide, a strip.
    const view = new View({ t0: DAY0 - 198 * DAY, t1: DAY0 + 2 * DAY, p0: day1.low - 2_000, p1: day2.high + 2_000 });
    const c = recordingCanvas();
    const geos = paintTpo(c.ctx, { profiles: [day1, day2], settings: { ...TPO_DEFAULTS, on: true }, view, pw: 600, ph: 300, p: palette, labels: new LabelBoard(), fold: 0, rank: () => 0, name: () => '', now: NOW + 2 * DAY, linesFor: () => true });
    assert.ok(geos.every(g => g.compact), label);
    const casings = c.fills.filter(f => f.style === palette.bg);
    assert.equal(casings.length, 1, `${label}: one casing fill for both profiles`);
    assert.equal(casings[0]!.alpha, 0.85);
    assert.equal(casings[0]!.rects.length, 2);
    const at = c.fills.indexOf(casings[0]!), bars2 = c.fills.filter((f, i) => i !== at && f.rects.length && f.style !== palette.bg && f.rects[0]!.length === 4 && f.rects[0]![2]! < 600);
    assert.ok(bars2.length >= 6, `${label}: range, value area and stripe of each`);
    assert.ok(bars2.every(f => c.fills.indexOf(f) > at), `${label}: every bar after the casing, so the second day's casing covers none of the first day's`);
    // A pixel round each strip: its range (the dimmest bar, the first of its three) one pixel larger every way.
    for (const [g, cased] of geos.map((g, i) => [g, casings[0]!.rects[i]!] as const)) {
      const range = bars2.find(f => f.rects.some(r => r[0] === g.x0))!.rects.find(r => r[0] === g.x0)!;
      assert.deepEqual(cased, [range[0]! - 1, range[1]! - 1, range[2]! + 2, range[3]! + 2], label);
    }
  }
});
