import test from 'node:test';
import assert from 'node:assert/strict';
import { oiStretch, type OiStretchInput } from '../src/app/range/oi-summary.ts';
import { chainedOi, oiDeltaByTime, oiSumOf, type OiPart } from '../src/app/oi-change.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';
import type { NlnsCandle } from '../src/app/delta/nlns.ts';

const H = 3_600_000, T = Date.UTC(2026, 10, 12, 0);
const bars = (values: number[], from = T): OiBar[] => values.map((v, i) => [from + i * H, v, v, v, v]);
const base = (oi: OiBar[], i0: number, i1: number): OiStretchInput => ({ oi, change: oiDeltaByTime(oi), i0, i1, tfMs: H, venues: null, counted: null, parts: [], who: null, candles: [], ownPrice: false, usd: null, flag: null });

test('one market: the level before the first bar and after the last, the change the bars add up to, and the largest fall inside', () => {
  const oi = bars([100, 104, 110, 98, 103, 120]);
  const s = oiStretch(base(oi, 1, 4))!;
  assert.deepEqual([s.start, s.end, s.change, s.bars, s.known], [100, 103, 3, 4, 4]);
  assert.equal(s.end - s.start, s.change);
  assert.deepEqual(s.fall, { amount: 12, from: T + 3 * H, to: T + 4 * H }, 'from 110 (the end of the bar that reached it) down to 98');
  assert.deepEqual(s.largest, { t: T + 3 * H, change: -12 });
  assert.deepEqual(s.half, { bars: 2, movement: 4 + 6 + 12 + 5 }, 'the 12 alone is not half of 27, with the 6 it is');
  assert.equal(s.t0, T + H); assert.equal(s.t1, T + 5 * H);
  assert.equal(oiStretch(base(oi, 4, 3)), null, 'no bar: nothing');
});

test('the first bar held has no change: it is unknown, not zero, and the stretch says how many bars it knows', () => {
  const oi = bars([100, 104, 110]);
  const s = oiStretch(base(oi, 0, 2))!;
  assert.deepEqual([s.bars, s.known, s.start, s.change], [3, 2, 100, 10]);
  assert.equal(s.rank, null, 'not every bar known: no rank among the stretches held');
});

test('against the stretches held: as many bars just before, and how many stretches of that length changed more', () => {
  const oi = bars([100, 101, 103, 102, 110, 111, 108, 109]);
  const s = oiStretch(base(oi, 4, 5))!;
  assert.equal(s.change, 9);
  assert.equal(s.before, 2 - 1, 'the two bars before: +2 and -1');
  assert.deepEqual(s.rank, { larger: 0, of: 6 }, 'six stretches of two bars hold known changes (3, 1, 7, 9, -2, -2): none moved more');
  assert.deepEqual(oiStretch(base(oi, 2, 3))!.rank, { larger: 5, of: 6 }, 'a +1 stretch: five moved more, either way (3, 7, 9, -2, -2)');
});

test('venues added together: each venue\'s part counted as the sum counts it, so the parts add up to the stretch\'s change', () => {
  // Bybit's readings start at the third bar: its whole open interest is not "opened" there.
  const parts: OiPart[] = [{ id: 'binance:BTCUSDT', bars: bars([100, 102, 101, 105]) }, { id: 'bybit:BTCUSDT', bars: bars([50, 53], T + 2 * H) }];
  const sum = oiSumOf(parts, H), oi = chainedOi(sum);
  const s = oiStretch({ ...base(oi, 1, 3), change: sum.change, venues: sum.venues, counted: oi.map(b => sum.counted.get(b[0]) ?? 0), parts })!;
  assert.equal(s.change, 2 - 1 + 4 + 3);
  assert.equal(s.venues.reduce((a, v) => a + v.change, 0), s.change, 'the venues add up to the stretch');
  assert.deepEqual(s.venues.find(v => v.id.startsWith('bybit')), { id: 'bybit:BTCUSDT', change: 3, bars: 1 }, 'counted from its first reading on, one bar');
  assert.deepEqual([s.venuesLow, s.venuesHigh, s.countedLow, s.countedHigh], [1, 2, 1, 2], 'levels of one to two venues; changes of one, then two once Bybit has a reading before its second');
  assert.equal(s.end - s.start, s.change);
});

test('who: the NL/NS candles of the stretch added up into estimated added and reduced, checked against the model\'s own change', () => {
  const oi = bars([100, 110, 105, 115]);
  const c = (t: number, lo: number, so: number, lc: number, sc: number, up: number, down: number): NlnsCandle => ({ t, dOi: lo + so + up - lc - sc - down, oiStart: 0, longOpened: lo, shortOpened: so, longClosed: lc, shortClosed: sc, unassigned: up + down, unknown: 0, unsidedUp: up, unsidedDown: down, longs: lo - lc, shorts: so - sc, v: 0, kind: null, side: 0, byPrice: t === T + 2 * H, coarse: false, covered: 1, counted: 2, fine: t === T + H ? 2 : 1, cum: 0, cumLongs: 0, cumShorts: 0, run: 0 });
  const who = new Map([c(T + H, 8, 2, 0, 0, 1, 0), c(T + 2 * H, 0, 1, 3, 3, 0, 0), c(T + 3 * H, 4, 6, 0, 0, 0, 0)].map(x => [x.t, x] as const));
  const candles: CandleRow[] = [[T + H, 99.5, 101, 99, 100, 1], [T + 2 * H, 102, 105, 101, 103, 1], [T + 3 * H, 107, 112, 106, 109, 1]];
  const s = oiStretch({ ...base(oi, 1, 3), who, candles, ownPrice: true })!;
  const w = s.who!;
  assert.deepEqual([w.longOpened, w.shortOpened, w.longClosed, w.shortClosed, w.unsidedUp, w.unsidedDown], [12, 9, 3, 3, 1, 0]);
  assert.deepEqual([w.added, w.reduced, w.dOi], [22, 6, 16]);
  assert.equal(w.added - w.reduced, w.dOi);
  assert.deepEqual([w.candles, w.byPrice, w.fineAll, w.known], [3, 1, 1, 10 - 5 + 10], "known: the bars' changes over the candles the model holds");
  assert.deepEqual(s.price, { open: 99.5, close: 109, high: 112, low: 99 }, 'the first open to the last close, over the same candles');
  assert.equal(oiStretch({ ...base(oi, 1, 3), who, candles, ownPrice: false })!.price, null, 'another market\'s candles say nothing of this price');
});

test('review r2: dollars of a bar with no net change in coins count; windows across a gap are not compared; a fall after an unknown bar starts at its end', () => {
  // Two venues valued at different prices: +10 coins at $100 on one and -10 at $90 (an inverse market at its own price) on the other.
  const oi = bars([100, 100, 105]);
  const usd = new Map([[T + H, 10 * 100 - 10 * 90], [T + 2 * H, 500]]);
  assert.equal(oiStretch({ ...base(oi, 1, 2), usd })!.usd, 100 + 500, 'the bar of no net change in coins brings its $100');
  // A gap: the bars at 0, 1 and 3 hours (2 is missing): no "two candles" window spans the gap, and none is compared there.
  const gap: OiBar[] = [[T, 10, 10, 10, 10], [T + H, 12, 12, 12, 12], [T + 3 * H, 20, 20, 20, 20], [T + 4 * H, 21, 21, 21, 21], [T + 5 * H, 25, 25, 25, 25]];
  const g = oiStretch(base(gap, 3, 4))!;
  assert.equal(g.before, null, 'the two bars before cross the gap');
  assert.deepEqual(g.rank, null, 'the bar after the gap changed over two hours: no window holds it, and one window alone is no rank');
  assert.equal(oiStretch(base(gap, 2, 3))!.rank, null, 'a stretch across the gap itself is not ranked');
  // A fall after an unknown bar: its level stands at that bar's end.
  const change = new Map([[T + 2 * H, -5]]);
  const f = oiStretch({ ...base(bars([0, 50, 45]), 1, 2), change })!;
  assert.deepEqual(f.fall, { amount: 5, from: T + 2 * H, to: T + 3 * H });
});

test('review r2: windows compare only with the same support as the stretch, and a forming stretch is not compared', () => {
  // Six bars; the change of the bars at 1..3 is made of one venue, of 4..5 of two.
  const oi = bars([100, 101, 103, 104, 110, 112]);
  const counted = [0, 1, 1, 1, 2, 2];
  const input = (i0: number, i1: number) => ({ ...base(oi, i0, i1), counted });
  const s = oiStretch(input(4, 5))!;
  assert.equal(s.before, null, 'the two candles before were made of one venue');
  assert.equal(s.rank, null, 'no other window of two candles made of two venues: one window alone is no rank');
  const one = oiStretch(input(2, 3))!;
  assert.equal(one.before, null, 'the candle before the first of one venue has no known change');
  assert.deepEqual(one.rank, { larger: 0, of: 2 }, 'windows (1,2) and (2,3) of one venue: +3 and +3, a tie is not larger');
  // Forming: the newest bar is under way.
  const live = oiStretch({ ...input(4, 5), formingFrom: T + 5 * H })!;
  assert.deepEqual([live.before, live.rank], [null, null]);
  const older = oiStretch({ ...input(1, 2), formingFrom: T + 5 * H })!;
  assert.deepEqual(older.rank, { larger: 0, of: 2 }, 'a closed stretch compares with closed windows (1,2), (2,3) only');
});

test('review r3: venues added together, a bar without its dollars makes the dollars unknown even where the coins cancel', () => {
  const oi = bars([100, 100, 105]);
  const usd = new Map([[T + 2 * H, 500]]);
  assert.equal(oiStretch({ ...base(oi, 1, 2), usd, counted: [0, 2, 2] })!.usd, null, 'the first bar (+10 and -10 coins) has no dollars');
  assert.equal(oiStretch({ ...base(oi, 1, 2), usd })!.usd, 500, 'one market: a bar of no change is no dollars either way');
});
