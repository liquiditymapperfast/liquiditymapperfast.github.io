import test from 'node:test';
import assert from 'node:assert/strict';
import { Ranker, pickTop, rankAll, type RankInput } from '../src/app/cvd/rank.ts';
import { BURST_DEFAULTS, burst } from '../src/app/cvd/burst.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { FlowSeries, type FlowFrame } from '../src/shared/flow.ts';

// What an independent review found wrong in the CVD column's calculations, each as the smallest case that shows it.

const input = (key: string, spot: number, perp: number): RankInput => ({ family: { key, lanes: [] }, spot, perp, quiet: false });
const keys = (rows: readonly { family: { key: string } }[]): string[] => rows.map(r => r.family.key);

test('a held ranking keeps a family that has slipped out of the top places, with its numbers of now', () => {
  const ranker = new Ranker(60_000, true);
  const start = rankAll([input('a', 10, 0), input('b', 8, 0), input('c', 5, 0)]);
  assert.deepEqual(keys(ranker.apply(0, pickTop(start, { top: 2 }), start)), ['a', 'b']);
  // c has overtaken b, so the ranking as it is now is a and c: b used to disappear, leaving one row where two are held.
  const later = rankAll([input('a', 10, 0), input('b', 4, 0), input('c', 9, 0)]);
  const held = ranker.apply(30_000, pickTop(later, { top: 2 }), later);
  assert.deepEqual(keys(held), ['a', 'b'], 'the list is held');
  assert.equal(held[1]!.gross, 4, 'b has its own current volume');
  assert.deepEqual(keys(ranker.apply(60_000, pickTop(later, { top: 2 }), later)), ['a', 'c'], 'and changes at the next re-rank');
});

test('a held list whose families have all gone is made again, so a ranking that is set by hand does not stay empty', () => {
  const ranker = new Ranker(60_000, false);
  const start = rankAll([input('a', 10, 0), input('b', 8, 0)]);
  ranker.apply(0, start, start);
  const unchanged = rankAll([input('a', 1, 0), input('b', 9, 0), input('c', 50, 0)]);
  // By hand the first layout's order stays while its families trade (b has passed a); an exchange that starts trading takes a free place
  // at the end, or a column that shows every exchange would leave it out for good.
  assert.deepEqual(keys(ranker.apply(10_000_000, unchanged, unchanged)), ['a', 'b', 'c'], 'by hand: the first layout stays while its families trade');
  const other = rankAll([input('x', 3, 0), input('y', 2, 0)]);
  assert.deepEqual(keys(ranker.apply(10_000_001, other, other)), ['x', 'y'], 'but not when none of them is there: that is another universe, not a layout to keep');
});

// ---- the flow book --------------------------------------------------------------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const frame = (id: string, t0: number, buy: number[], sell: number[]): FlowFrame => ({ from: t0, to: t0 + buy.length * 1000, instruments: [{ id, t0, buy: Float32Array.from(buy), sell: Float32Array.from(sell) }] });

test('a second pushed before the history was taken does not take the history\'s second back', () => {
  const book = new FlowBook(), sec = T0 / 1000;
  book.begin(['a']);
  book.apply([['a', T0, 100, 0]]);                                    // sent early, held while the history came
  book.load(frame('a', T0, [200], [0]), ['a'], T0 - 60_000);       // the history already has 200 for that second
  assert.equal(book.get('a')!.delta(sec, sec), 200, 'it was 100');
  book.apply([['a', T0, 250, 10]]);
  assert.equal(book.get('a')!.delta(sec, sec), 240, 'a push that is further along still replaces it');
});

test('after the live stream broke, history is asked for again, and an answer to a request that began before does not count as covering it', () => {
  const book = new FlowBook(), from = T0 - 60_000;
  book.begin(['a']); book.load(frame('a', T0, [1], [0]), ['a'], from);
  assert.deepEqual(book.missing(['a'], from), []);
  book.invalidate();
  assert.deepEqual(book.missing(['a'], from), ['a'], 'the seconds the stream missed are in the recordings, not in the book');
  book.begin(['a']);
  book.invalidate();                                                  // the stream broke again while this request was on its way
  book.load(frame('a', T0, [1], [0]), ['a'], from);
  assert.deepEqual(book.missing(['a'], from), ['a'], 'its answer may predate the gap');
  book.begin(['a']); book.load(frame('a', T0, [1], [0]), ['a'], from);
  assert.deepEqual(book.missing(['a'], from), [], 'one that began after does');
});

// ---- bursts -----------------------------------------------------------------------------------------------------------------------------------------

function flatSeries(nowSec: number, seconds: number, perSecond: [number, number]): FlowSeries {
  const s = new FlowSeries(); for (let i = seconds; i >= 0; i--) s.set(nowSec - i, perSecond[0], perSecond[1]); return s;
}

test('a baseline that never varied is not a burst when the window is exactly what it always is', () => {
  const now = 2_000_000, s = flatSeries(now, 3_000, [200_000, 0]);      // every ten seconds: +2 M, exactly
  assert.equal(burst(s, now), null, 'the delta is the mean (it was reported as an infinite burst)');
  for (let i = 0; i < 10; i++) s.set(now - i, 500_000, 0);               // 5 M in ten seconds against a flat 2 M
  const found = burst(s, now)!;
  assert.ok(found && found.z === Infinity && found.delta === 5_000_000, JSON.stringify(found));
  const selling = flatSeries(now, 3_000, [200_000, 0]);
  for (let i = 0; i < 10; i++) selling.set(now - i, 0, 500_000);        // the other way: -5 M against +2 M
  assert.equal(burst(selling, now)!.z, -Infinity);
  const small = flatSeries(now, 3_000, [200_000, 0]);
  for (let i = 0; i < 10; i++) small.set(now - i, 205_000, 0);          // 2.05 M: 50 k above a flat baseline, under the minimum
  assert.equal(burst(small, now, { ...BURST_DEFAULTS, minUsd: 1_000_000 }), null, 'a distance under the floor is not worth a mention');
});
