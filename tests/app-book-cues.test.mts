import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BookCueTracker, CUE_HISTORY, DEFAULT_TUNING, FORGET_MS, GAP_CADENCES, LV_STEPS, MERGE_DISTANCE_SHARE, MERGE_FINEST, MIN_GAP_MS, PAIR_BINS, TAU_ACTIVITY_MS, TAU_FRESH_MS, ZONE_STEPS, rowEventAt, rowEvents, type CueBook, type CueContext, type CueEvent, type CueTuning } from '../src/app/panes/book-cues.ts';
import { bucketWidth, mergeByDistance } from '../src/shared/merge.ts';
import { binOf } from '../src/shared/footprint.ts';
import { gridStepFor } from '../src/shared/grid.ts';
import { accumulateSide } from '../src/shared/recorder.ts';
import type { SideArrays } from '../src/app/wire.ts';

// BTC's grid at $81k is $20. The mid sits on the edge between bin 4063 (the best bid's) and bin 4064 (the best ask's): $81,280.
const G = 20, MID = 4_064, ID = 'binance:BTCUSDT';
interface Ladder { bids: Map<number, number>; asks: Map<number, number> }

/** Bins of USD: the bids fill the bins below the mid bin, the asks the mid bin and above, `depth` deep (past the zone), `usd` each. */
const ladder = (usd = 1_000_000, depth = 400, mid = MID): Ladder => {
  const bids = new Map<number, number>(), asks = new Map<number, number>();
  for (let k = 1; k <= depth; k++) bids.set(mid - k, usd);
  for (let k = 0; k < depth; k++) asks.set(mid + k, usd);
  return { bids, asks };
};
const copy = (l: Ladder): Ladder => ({ bids: new Map(l.bids), asks: new Map(l.asks) });
const price = (bin: number, g = G): number => (bin + 0.5) * g;
const sideOf = (m: Map<number, number>, bid: boolean, g: number): SideArrays => {
  const bins = [...m.entries()].filter(([, usd]) => usd > 0).sort((a, b) => bid ? b[0] - a[0] : a[0] - b[0]);
  const lo = Float64Array.from(bins, ([bin]) => price(bin, g));
  return { lo, hi: lo, usd: Float64Array.from(bins, ([, usd]) => usd) };
};
/** A published book: one level at each bin's centre; `step: null` leaves the grid unpublished. */
const book = (id: string, ts: number, l: Ladder, o: { step?: number | null; g?: number; coarse?: boolean } = {}): CueBook => {
  const g = o.g ?? G;
  const b: CueBook = { id, timestamp: ts, coarse: o.coarse ?? false, bids: sideOf(l.bids, true, g), asks: sideOf(l.asks, false, g) };
  if (o.step !== null) b.step = o.step ?? g;
  return b;
};
const ctx = (wall: number, floorUsd = 10_000): CueContext => ({ wall, scale: 1_000_000, floorUsd });
/** Every change of $0.5 or more is an event at once: the gate, the noise and the confirmation out of the way. */
const open: Partial<CueTuning> = { meanShare: 0, noiseMultiple: 0, confirmRatio: 0 };
const tiny = (wall: number): CueContext => ({ wall, scale: 1_000_000, floorUsd: 0.5 });
/** A change too small to be an event, to make a publication distinct. */
const nudge = (l: Ladder, k = 1): Ladder => { const n = copy(l); n.bids.set(MID - 300, 1_000_000 + k); return n; };
const only = (events: readonly CueEvent[]): CueEvent => { assert.equal(events.length, 1, `one event, got ${JSON.stringify(events.map(e => [e.side, e.lo, e.usd]))}`); return events[0]!; };
/** The sizes of the cells that hold an event, by side and bin. */
const byBin = (events: readonly CueEvent[], side: 'bid' | 'ask'): Map<number, number> => new Map(events.filter(e => e.side === side).map(e => [Math.round(e.lo / e.grid), e.usd]));
/** The rows of `events` on rows of `step` (a scale of $1M): [row, its own signed change in USD]. */
const rowsOf = (events: readonly CueEvent[], step: number, window?: { lo: number; hi: number }): [number, number][] => rowEvents(events, step, 1_000_000, window).map(r => [r.row, r.usd]);

test('the first publication of a book is a baseline and a repeat of it is nothing at all', () => {
  const tr = new BookCueTracker(), b = book(ID, 1_000, ladder());
  assert.deepEqual(tr.observe([b], [ID], ctx(1_000)), []);
  assert.equal(tr.stats.baselines, 1);
  assert.deepEqual(tr.observe([b], [ID], ctx(1_250)), []);
  assert.deepEqual(tr.observe([b], [ID], ctx(1_500)), []);
  assert.deepEqual({ frames: tr.stats.frames, observations: tr.stats.observations, distinct: tr.stats.distinct, baselines: tr.stats.baselines }, { frames: 3, observations: 3, distinct: 1, baselines: 1 });
});

test('a copy of the book in new arrays is still a repeat, a new stamp with the same levels is a publication that raises nothing', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([book(ID, 1_000, l)], [ID], ctx(1_250)), [], 'rebuilt arrays, same content');
  assert.equal(tr.stats.distinct, 1);
  assert.deepEqual(tr.observe([book(ID, 2_000, l)], [ID], ctx(2_000)), []);
  assert.equal(tr.stats.distinct, 2, 'a new stamp is a publication');
  assert.equal(tr.stats.events, 0);
});

test('a large change is raised at once, with the cell, its before and after and a strength from the reference size', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); next.bids.set(MID - 3, 2_000_000);
  const e = only(tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000)));
  assert.deepEqual({ id: e.id, side: e.side, lo: e.lo, hi: e.hi, grid: e.grid, sign: e.sign, usd: e.usd, before: e.before, after: e.after, wall: e.wall, removed: e.removed, added: e.added, pair: e.pair, approx: e.approx, band: e.band, confirmed: e.confirmed },
    { id: ID, side: 'bid', lo: (MID - 3) * G, hi: (MID - 2) * G, grid: G, sign: 1, usd: 1_000_000, before: 1_000_000, after: 2_000_000, wall: 2_000, removed: false, added: false, pair: false, approx: false, band: false, confirmed: false });
  assert.ok(Math.abs(e.strength - (1 - Math.exp(-1))) < 1e-12);
  assert.equal(e.seq, 1);
});

test('an addition and a removal of the same size have the same strength, whichever the side', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); next.bids.set(MID - 10, 1_500_000); next.asks.set(MID + 10, 500_000);
  const events = tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000));
  assert.equal(events.length, 2);
  const [bid, ask] = events as [CueEvent, CueEvent];
  assert.deepEqual([bid.side, bid.sign, ask.side, ask.sign], ['bid', 1, 'ask', -1]);
  assert.equal(bid.strength, ask.strength);
  assert.ok(bid.seq < ask.seq, 'bids before asks, seq increasing along the returned order');
});

test('a weak change waits for the next publication: raised when it still stands, with the change since the value before it', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const weak = copy(l); weak.asks.set(MID + 5, 1_100_000);                         // +$100k: over the gate (50k), under three of it
  assert.deepEqual(tr.observe([book(ID, 2_000, weak)], [ID], ctx(2_000)), [], 'one publication alone shows nothing');
  const e = only(tr.observe([book(ID, 3_000, nudge(weak))], [ID], ctx(3_000)));
  assert.deepEqual({ side: e.side, usd: e.usd, before: e.before, after: e.after, confirmed: e.confirmed, wall: e.wall }, { side: 'ask', usd: 100_000, before: 1_000_000, after: 1_100_000, confirmed: true, wall: 3_000 });
  assert.ok(Math.abs(e.strength - (1 - Math.exp(-0.1))) < 1e-12);
  assert.equal(tr.stats.weakDropped, 0);
});

test('a weak change that came back, or went the other way, is dropped, and is no event from a value nobody saw', () => {
  const l = ladder(), weak = copy(l); weak.asks.set(MID + 5, 1_100_000);
  const at = (usd: number): Ladder => { const x = copy(l); x.asks.set(MID + 5, usd); return x; };
  for (const [name, next, expected] of [['back', nudge(l), 0], ['under the gate', at(1_030_000), 0], ['other way', at(700_000), 1]] as const) {
    const tr = new BookCueTracker();
    tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
    assert.deepEqual(tr.observe([book(ID, 2_000, weak)], [ID], ctx(2_000)), []);
    const events = tr.observe([book(ID, 3_000, next)], [ID], ctx(3_000));
    assert.equal(tr.stats.weakDropped, 1, name);
    assert.equal(events.length, expected, name);
    // The one that went the other way is a large change from the value before the weak one, which is what the reader last saw.
    if (expected) assert.deepEqual([events[0]!.usd, events[0]!.before], [-300_000, 1_000_000]);
  }
});

test('two weak steps the same way add up and are raised by the second', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const a = copy(l); a.bids.set(MID - 4, 1_070_000);
  assert.deepEqual(tr.observe([book(ID, 2_000, a)], [ID], ctx(2_000)), []);
  const b = copy(l); b.bids.set(MID - 4, 1_140_000);
  const e = only(tr.observe([book(ID, 3_000, b)], [ID], ctx(3_000)));
  assert.deepEqual([e.usd, e.before, e.after, e.confirmed], [140_000, 1_000_000, 1_140_000, true]);
});

test('a repeated frame never confirms a weak change', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const weak = copy(l); weak.asks.set(MID + 5, 1_100_000);
  const b = book(ID, 2_000, weak);
  assert.deepEqual(tr.observe([b], [ID], ctx(2_000)), []);
  for (const wall of [2_250, 2_500, 2_750, 3_000]) assert.deepEqual(tr.observe([b], [ID], ctx(wall)), [], 'the same book again');
  assert.equal(tr.stats.events, 0);
  assert.equal(tr.observe([book(ID, 3_100, nudge(weak))], [ID], ctx(3_100)).length, 1, 'the next real publication confirms it');
});

test('the gate is the floor on a thin book and a share of the mean cell on a deep one', () => {
  // Thin: $100k a cell, so 5 % of the mean is 5k and the floor, 10k, decides.
  const thin = new BookCueTracker(), t = ladder(100_000);
  thin.observe([book(ID, 1_000, t)], [ID], ctx(1_000));
  const t1 = copy(t); t1.bids.set(MID - 2, 109_000);
  assert.deepEqual(thin.observe([book(ID, 2_000, t1)], [ID], ctx(2_000)), [], 'under the floor');
  const t2 = copy(t); t2.bids.set(MID - 2, 145_000);                                 // +36k against the last publication (109k): three gates, at once
  assert.equal(thin.observe([book(ID, 3_000, t2)], [ID], ctx(3_000)).length, 1, 'over three times the floor: at once');
  // Deep: $20M a cell, 5 % is $1M, so $600k is no change at all (not even a waiting one).
  const deep = new BookCueTracker(), d = ladder(20_000_000);
  deep.observe([book(ID, 1_000, d)], [ID], ctx(1_000));
  const d1 = copy(d); d1.asks.set(MID + 3, 20_600_000);
  assert.deepEqual(deep.observe([book(ID, 2_000, d1)], [ID], ctx(2_000)), []);
  assert.deepEqual(deep.observe([book(ID, 3_000, nudge(d1))], [ID], ctx(3_000)), []);
  assert.equal(deep.stats.weakDropped, 0);
});

test('the gate rises with the noise: where every cell jitters, a change that would show on a calm book does not', () => {
  const jitter = (up: boolean): Ladder => ladder(up ? 1_030_000 : 1_000_000);
  const noisy = new BookCueTracker(), calm = new BookCueTracker();
  noisy.observe([book(ID, 1_000, jitter(false))], [ID], ctx(1_000)); calm.observe([book(ID, 1_000, ladder())], [ID], ctx(1_000));
  for (let k = 1; k <= 6; k++) assert.deepEqual(noisy.observe([book(ID, 1_000 + k * 1_000, jitter(k % 2 === 1))], [ID], ctx(1_000 + k * 1_000)), [], 'a $30k jitter is under the gate');
  const probe = (base: Ladder): Ladder => { const x = copy(base); x.asks.set(MID + 100, x.asks.get(MID + 100)! + 80_000); return x; };
  // $80k: over a calm book's gate (50k), under the noisy book's (three times the 30k noise).
  assert.deepEqual(calm.observe([book(ID, 8_000, probe(ladder()))], [ID], ctx(8_000)), []);
  assert.equal(calm.observe([book(ID, 9_000, nudge(probe(ladder())))], [ID], ctx(9_000)).length, 1, 'waiting, then raised');
  const before = noisy.stats.weakDropped;
  assert.deepEqual(noisy.observe([book(ID, 8_000, probe(jitter(false)))], [ID], ctx(8_000)), []);
  assert.deepEqual(noisy.observe([book(ID, 9_000, nudge(probe(jitter(false))))], [ID], ctx(9_000)), []);
  assert.equal(noisy.stats.weakDropped, before, 'it never even waited');
});

// ---- When a book starts again ----

test('a changed grid, a changed kind or a stamp far back starts the book again, and nothing is raised from the first publication after it', () => {
  const l = ladder(), big = copy(l); big.bids.set(MID - 3, 3_000_000);
  const start = (): BookCueTracker => { const tr = new BookCueTracker(); tr.observe([book(ID, 100_000, l)], [ID], ctx(1_000)); return tr; };
  // A grid of 40 where it was 20.
  let tr = start();
  assert.deepEqual(tr.observe([book(ID, 101_000, big, { step: 40 })], [ID], ctx(2_000)), []);
  assert.equal(tr.stats.baselines, 2); assert.equal(tr.info(ID)!.grid, 40);
  // Banded where it was points, and points again.
  tr = start();
  assert.deepEqual(tr.observe([book(ID, 101_000, big, { coarse: true })], [ID], ctx(2_000)), []);
  assert.deepEqual(tr.observe([book(ID, 102_000, big)], [ID], ctx(3_000)), []);
  assert.equal(tr.stats.baselines, 3);
  // A stamp five seconds back: another epoch of the venue. Half a second back is a venue's jitter and the book goes on.
  tr = start();
  assert.deepEqual(tr.observe([book(ID, 95_000, big)], [ID], ctx(2_000)), []);
  assert.equal(tr.stats.baselines, 2);
  tr = start();
  assert.equal(tr.observe([book(ID, 99_500, big)], [ID], ctx(2_000)).length, 1);
  assert.equal(tr.stats.baselines, 1);
  // The page's own clock stepping back is the same.
  tr = start();
  assert.deepEqual(tr.observe([book(ID, 101_000, big)], [ID], ctx(-50_000)), []);
  assert.equal(tr.stats.baselines, 2);
});

test('a book whose coverage epoch changes starts over as on first sight: a book seeded again raises nothing from its differences', () => {
  // A full-depth book seeded again after a gap can differ inside its window from the copy before it (the stream moved on, a replica
  // differs): with a new epoch that is a new baseline, not liquidity placed or pulled. Growth past the old reach raises nothing either way
  // (bins past the deepest level were unknown), so the epoch matters for the inside.
  const l = ladder(1_000_000, 100), reseeded = copy(l);
  reseeded.bids.set(MID - 5, 9_000_000); reseeded.asks.delete(MID + 7);
  const tr = new BookCueTracker({ ...DEFAULT_TUNING, ...open });
  assert.deepEqual(tr.observe([{ ...book(ID, 1_000, l), epoch: 3 }], [ID], tiny(1_000)), []);
  assert.deepEqual(tr.observe([{ ...book(ID, 1_250, reseeded), epoch: 4 }], [ID], tiny(1_250)), [], 'a new epoch: a baseline, no events');
  assert.equal(tr.stats.baselines, 2);
  // Within one epoch a change is raised as before.
  const changed = copy(reseeded); changed.bids.set(MID - 6, 5_000_000);
  assert.equal(only(tr.observe([{ ...book(ID, 1_500, changed), epoch: 4 }], [ID], tiny(1_500))).usd, 4_000_000);
  // The same differences without a new epoch are two events.
  const plain = new BookCueTracker({ ...DEFAULT_TUNING, ...open });
  plain.observe([book(ID, 1_000, l)], [ID], tiny(1_000));
  assert.equal(plain.observe([book(ID, 1_250, reseeded)], [ID], tiny(1_250)).length, 2);
});

test('a published grid and an inferred one agree on the cells but not on the claim: the events say which', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l, { step: null })], [ID], ctx(1_000));
  assert.equal(tr.info(ID)!.grid, gridStepFor(81_280)); assert.equal(tr.info(ID)!.approx, true);
  const next = copy(l); next.bids.set(MID - 3, 2_000_000);
  assert.equal(only(tr.observe([book(ID, 2_000, next, { step: null })], [ID], ctx(2_000))).approx, true);
  // The book publishes its grid from now on: the same grid, so no start again, and the events are no longer flagged.
  const more = copy(next); more.bids.set(MID - 3, 3_000_000);
  const e = only(tr.observe([book(ID, 3_000, more)], [ID], ctx(3_000)));
  assert.equal(e.approx, false); assert.equal(tr.stats.baselines, 1);
  // A step that is not a number is no published grid.
  tr.observe([book(ID, 4_000, more, { step: Number.NaN })], [ID], ctx(4_000));
  assert.equal(tr.info(ID)!.approx, true);
});

test('a gap is judged against the book\'s own rhythm: a 5.4 s book is never one, a 1 s book silent for twenty seconds is', () => {
  const tr = new BookCueTracker(), A = 'a', B = 'b', a = ladder(), b = ladder();
  let ba = book(A, 0, a), bb = book(B, 0, b);
  const events: CueEvent[] = [];
  // A frame every 100 ms; A publishes every second until 30 s, is silent until 51 s and then publishes again; B publishes every 5.4 s throughout.
  for (let t = 0; t <= 80_000; t += 100) {
    if (t % 1_000 === 0 && (t <= 30_000 || t >= 51_000)) {
      const l = copy(a); if (t >= 51_000) l.asks.set(MID + 4, t === 51_000 ? 3_000_000 : 5_000_000);
      ba = book(A, t, nudge(l, (t / 1_000) % 7 + 1));
    }
    if (t % 5_400 === 0) bb = book(B, t, nudge(b, (t / 5_400) % 7 + 1));
    const raised = tr.observe([ba, bb], [A, B], ctx(t));
    events.push(...raised);
    if (t === 30_000) assert.ok(Math.abs(tr.info(A)!.cadenceMs - 1_000) < 50, `cadence ${tr.info(A)!.cadenceMs}`);
    if (t === 51_000) assert.deepEqual(raised, [], 'back from twenty seconds of silence: a baseline, whatever it shows');
  }
  assert.ok(Math.abs(tr.info(B)!.cadenceMs - 5_400) < 50, `cadence ${tr.info(B)!.cadenceMs}`);
  assert.equal(tr.stats.baselines, 3, 'the two first publications and the book that went silent; the 5.4 s book is never a gap');
  assert.deepEqual(events.map(e => [e.id, e.usd, e.wall]), [[A, 2_000_000, 52_000]], 'only the book that came back, one publication after its baseline');
});

test('a book that always publishes every twelve seconds is a gap once, learns its rhythm and is compared from then on', () => {
  const tr = new BookCueTracker(), l = ladder();
  const at = (k: number): Ladder => { const x = copy(l); x.asks.set(MID + 4, 1_000_000 + 2_000_000 * k); return x; };
  assert.deepEqual(tr.observe([book(ID, 0, at(0))], [ID], ctx(0)), []);
  assert.deepEqual(tr.observe([book(ID, 12_000, at(1))], [ID], ctx(12_000)), [], 'twelve seconds with no rhythm known yet is over the minimum gap');
  assert.equal(tr.info(ID)!.cadenceMs, 12_000);
  assert.equal(only(tr.observe([book(ID, 24_000, at(2))], [ID], ctx(24_000))).usd, 2_000_000);
  assert.equal(tr.stats.baselines, 2);
});

test('a book left out of the ids is held for a while and forgotten after FORGET_MS: it starts again when it comes back', () => {
  const tr = new BookCueTracker(), l = ladder(), big = copy(l); big.asks.set(MID + 4, 3_000_000);
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  for (const wall of [2_000, 3_000, 4_000, 5_000]) tr.observe([book(ID, 1_000, l)], [], ctx(wall));
  assert.ok(tr.info(ID), 'four seconds out of the ids: still held');
  assert.equal(only(tr.observe([book(ID, 6_000, big)], [ID], ctx(6_000))).usd, 2_000_000, 'compared with what it was');
  for (let wall = 7_000; wall <= 6_000 + FORGET_MS + 1_000; wall += 1_000) tr.observe([book(ID, 6_000, big)], [], ctx(wall));
  assert.equal(tr.info(ID), null, 'forgotten');
  assert.deepEqual(tr.observe([book(ID, 50_000, l)], [ID], ctx(50_000)), [], 'a baseline');
  // Absent from the frames while its id is still asked for: the same.
  for (let wall = 51_000; wall <= 51_000 + FORGET_MS + 1_000; wall += 1_000) tr.observe([], [ID], ctx(wall));
  assert.equal(tr.info(ID), null);
});

test('reset forgets every book, and the ids a frame does not ask for are not tracked', () => {
  const tr = new BookCueTracker(), l = ladder(), big = copy(l); big.asks.set(MID + 4, 3_000_000);
  tr.observe([book(ID, 1_000, l), book('other', 1_000, l)], [ID], ctx(1_000));
  assert.equal(tr.info('other'), null); assert.equal(tr.size().books, 1);
  tr.reset();
  assert.equal(tr.info(ID), null);
  assert.equal(tr.heat(ID, 'bid', ...cell(MID - 5), 1_500), null, 'and with it the estimates');
  assert.deepEqual(tr.observe([book(ID, 2_000, big)], [ID], ctx(2_000)), [], 'a baseline');
});

// ---- Where a cell is compared ----

test('the mid moving moves the zone, and the cells that did not change raise nothing; the asks that were eaten do', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const zone = tr.info(ID)!.zone;
  assert.deepEqual(zone, { lo: (MID - ZONE_STEPS) * G, hi: (MID + ZONE_STEPS) * G });
  const next = copy(l); next.asks.delete(MID); next.asks.delete(MID + 1);        // the best ask moves up two bins, the mid by one
  const events = tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000));
  assert.deepEqual([...byBin(events, 'ask')], [[MID, -1_000_000], [MID + 1, -1_000_000]]);
  assert.ok(events.every(e => e.side === 'ask' && e.removed), 'a removal at the touch is a normal event, and the cells next to it are quiet');
  assert.equal(tr.info(ID)!.zone.lo - zone.lo, G, 'the zone moved one bin');
});

test('a bid that comes into the spread is an addition: the spread was known to be empty', () => {
  const l = ladder(); for (let k = 0; k < 5; k++) l.asks.delete(MID + k);          // the best ask is at MID + 5: five empty bins between it and the best bid
  const tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); next.bids.set(MID + 2, 2_000_000);
  const e = only(tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000)));
  assert.deepEqual([e.side, e.lo / G, e.added, e.removed, e.before, e.after], ['bid', MID + 2, true, false, 0, 2_000_000]);
});

test('a crossed book is not a book: nothing is raised, and the next good one is a baseline', () => {
  const l = ladder(), tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const crossed = copy(l); crossed.bids.set(MID + 10, 2_000_000);                  // a bid above the best ask
  assert.deepEqual(tr.observe([book(ID, 2_000, crossed)], [ID], ctx(2_000)), []);
  assert.equal(tr.info(ID)!.usable, false);
  assert.equal(tr.heat(ID, 'bid', (MID - 5) * G, (MID - 4) * G, 2_000), null);
  const big = copy(l); big.asks.set(MID + 4, 3_000_000);
  assert.deepEqual(tr.observe([book(ID, 3_000, big)], [ID], ctx(3_000)), []);
  assert.equal(tr.stats.baselines, 2);
  assert.deepEqual(tr.observe([book(ID, 4_000, nudge(big))], [ID], ctx(4_000)), []);
  const bigger = copy(big); bigger.asks.set(MID + 4, 5_000_000);
  assert.equal(only(tr.observe([book(ID, 5_000, bigger)], [ID], ctx(5_000))).usd, 2_000_000, 'compared again');
});

test('cells past the zone are never compared, however much they change; the last cells inside it are', () => {
  const tr = new BookCueTracker(), l = ladder(1_000_000, 600);
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l);
  next.asks.set(MID + 249, 9_000_000); next.asks.set(MID + 300, 9_000_000);        // the zone ends with bin MID + 248
  next.bids.set(MID - 250, 9_000_000); next.bids.set(MID - 320, 9_000_000);        // and starts with MID - 249
  assert.deepEqual(tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000)), []);
  const edge = copy(next); edge.asks.set(MID + 248, 9_000_000); edge.bids.set(MID - 249, 9_000_000);
  const events = tr.observe([book(ID, 3_000, edge)], [ID], ctx(3_000));
  assert.deepEqual([[...byBin(events, 'bid')], [...byBin(events, 'ask')]], [[[MID - 249, 8_000_000]], [[MID + 248, 8_000_000]]]);
});

test('a cell past the lowest bid or the highest ask is unknown, and so is the bin that holds them: a depth limit moving is no pull', () => {
  const thin = ladder(1_000_000, 50), tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, thin)], [ID], ctx(1_000));
  const edge = copy(thin); edge.bids.set(MID - 50, 9_000_000); edge.asks.set(MID + 49, 9_000_000);
  assert.deepEqual(tr.observe([book(ID, 2_000, edge)], [ID], ctx(2_000)), [], 'the bins holding the outermost levels may be cut');
  const inner = copy(edge); inner.bids.set(MID - 49, 9_000_000); inner.asks.set(MID + 48, 9_000_000);
  assert.equal(tr.observe([book(ID, 3_000, inner)], [ID], ctx(3_000)).length, 2);
  // The depth limit comes in: the venue shows ten bins fewer on the ask side. Nothing was pulled.
  const shorter = copy(inner); for (let k = 41; k <= 49; k++) shorter.asks.delete(MID + k);
  assert.deepEqual(tr.observe([book(ID, 4_000, shorter)], [ID], ctx(4_000)), []);
  // And back: the ten bins return as they were, which is nothing to see either.
  assert.deepEqual(tr.observe([book(ID, 5_000, inner)], [ID], ctx(5_000)), []);
});

test('the zone follows the tuning: a narrower one compares fewer bins and holds fewer', () => {
  const tr = new BookCueTracker({ zoneSteps: 10 }), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); next.asks.set(MID + 9, 3_000_000); next.asks.set(MID + 10, 3_000_000);
  assert.deepEqual([...byBin(tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000)), 'ask')], [[MID + 9, 2_000_000]]);
  assert.equal(tr.size().bins, 2 * (2 * 10 + 2 * 8 + 4));
});

// ---- The merge: why the cell is a bin of the book's own grid ----

const rng = (seed: number): (() => number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** A native book: USD by price in tenths of a dollar (integers, so sums are exact), around `centre`, with levels well past the zone on both sides. */
interface Native { bids: Map<number, number>; asks: Map<number, number>; centre: number }
const SENTINEL = 58_000;
const nativeBook = (rnd: () => number, centre: number): Native => {
  const n: Native = { bids: new Map(), asks: new Map(), centre };
  for (const bid of [true, false]) {
    const m = bid ? n.bids : n.asks;
    for (let i = 0; i < 700; i++) { const d = 1 + Math.floor(rnd() * rnd() * 54_000); m.set(bid ? centre - d : centre + d, 1_000 + Math.floor(rnd() * 99_000)); }
    m.set(bid ? centre - SENTINEL : centre + SENTINEL, 50_000); m.set(bid ? centre - SENTINEL - 1_000 : centre + SENTINEL + 1_000, 50_000);
  }
  return n;
};
const cloneNative = (n: Native): Native => ({ bids: new Map(n.bids), asks: new Map(n.asks), centre: n.centre });
/** Some levels resized, removed and added at random distances, and often the best levels of a side taken (the mid moves). */
const mutate = (rnd: () => number, n: Native): Native => {
  const out = cloneNative(n);
  for (let i = 0; i < 25; i++) {
    const bid = rnd() < 0.5, m = bid ? out.bids : out.asks, keys = [...m.keys()], k = keys[Math.floor(rnd() * keys.length)]!, r = rnd();
    const sentinel = Math.abs(k - n.centre) >= SENTINEL;
    if (r < 0.4 && !sentinel) m.set(k, Math.max(1_000, Math.round(m.get(k)! * (0.3 + rnd() * 3.7))));
    else if (r < 0.7 && !sentinel) m.delete(k);
    else { const d = 1 + Math.floor(rnd() * rnd() * 30_000); m.set(bid ? n.centre - d : n.centre + d, 1_000 + Math.floor(rnd() * 59_000)); }
  }
  if (rnd() < 0.5) {
    const bid = rnd() < 0.5, m = bid ? out.bids : out.asks;
    const sorted = [...m.keys()].sort((a, b) => bid ? b - a : a - b);
    for (let i = 0, take = 1 + Math.floor(rnd() * 3); i < take; i++) m.delete(sorted[i]!);
  }
  return out;
};
const arraysOf = (m: Map<number, number>, bid: boolean): SideArrays => {
  const keys = [...m.keys()].sort((a, b) => bid ? b - a : a - b);
  const lo = Float64Array.from(keys, k => k / 10);
  return { lo, hi: lo, usd: Float64Array.from(keys, k => m.get(k)!) };
};
/** What the server (and the browser engine) publish of a native book: merged by distance from its own mid, on the grid `step`. */
const published = (n: Native, step = G): { bids: SideArrays; asks: SideArrays } => {
  const b = arraysOf(n.bids, true), a = arraysOf(n.asks, false), mid = (b.lo[0]! + a.lo[0]!) / 2;
  return { bids: mergeByDistance(b, mid, step, true), asks: mergeByDistance(a, mid, step, false) };
};
const pubBook = (id: string, ts: number, p: { bids: SideArrays; asks: SideArrays }, step = G): CueBook => ({ id, timestamp: ts, coarse: false, step, bids: p.bids, asks: p.asks });
const sumsOf = (s: SideArrays, g: number): Map<number, number> => { const m = new Map<number, number>(); for (let i = 0; i < s.usd.length; i++) { const b = binOf(s.lo[i]!, g); m.set(b, (m.get(b) ?? 0) + s.usd[i]!); } return m; };
const nativeSums = (m: Map<number, number>, g: number): Map<number, number> => { const out = new Map<number, number>(); for (const [k, usd] of m) { const b = binOf(k / 10, g); out.set(b, (out.get(b) ?? 0) + usd); } return out; };
const highest = (a: Float64Array): number => { let v = -Infinity; for (const x of a) if (x > v) v = x; return v; };
const lowest = (a: Float64Array): number => { let v = Infinity; for (const x of a) if (x < v) v = x; return v; };
/** The zone and the best prices of a published book on a grid, worked out here from the definitions (a bin whose edges are within `ZONE_STEPS` steps of the mid). */
const zoneOf = (p: { bids: SideArrays; asks: SideArrays }, g: number): { z0: number; z1: number; bidBin: number; askBin: number } => {
  const bestBid = highest(p.bids.hi), bestAsk = lowest(p.asks.lo), m = (bestBid + bestAsk) / 2 / g;
  return { z0: Math.ceil(m - ZONE_STEPS), z1: Math.floor(m + ZONE_STEPS) - 1, bidBin: binOf(bestBid, g), askBin: binOf(bestAsk, g) };
};

test('the distance merge keeps the native USD per cell of its own grid inside the zone, and does not on a $25 or $50 row grid', () => {
  const rnd = rng(7), wrong = { 20: 0, 25: 0, 50: 0 } as Record<number, number>;
  let merged = 0;
  for (let trial = 0; trial < 40; trial++) {
    const n = nativeBook(rnd, 812_000 + Math.floor(rnd() * 8_000)), p = published(n);
    if (p.bids.usd.length < n.bids.size) merged++;
    const bestBid = highest(p.bids.hi), bestAsk = lowest(p.asks.lo), mid = (bestBid + bestAsk) / 2;
    for (const g of [20, 25, 50]) for (const [pub, nat] of [[p.bids, n.bids], [p.asks, n.asks]] as const) {
      const a = sumsOf(pub, g), b = nativeSums(nat, g);
      for (const bin of new Set([...a.keys(), ...b.keys()])) {
        if (bin * g < mid - ZONE_STEPS * 20 || (bin + 1) * g > mid + ZONE_STEPS * 20) continue;
        if ((a.get(bin) ?? 0) !== (b.get(bin) ?? 0)) wrong[g]!++;
      }
    }
  }
  assert.ok(merged > 30, 'the books were merged');
  assert.equal(wrong[20], 0, 'on the merge grid, not one cell differs from the native book');
  assert.ok(wrong[25]! > 0 && wrong[50]! > 0, `on a row grid that is not a multiple of the merge step it does: ${JSON.stringify(wrong)}`);
});

test('the tracker raises exactly the native changes of a merged book, whatever the merge does as the mid moves: no artifact and no miss', () => {
  const rnd = rng(11);
  let compared = 0, changed = 0, merged = 0;
  for (let trial = 0; trial < 100; trial++) {
    const n0 = nativeBook(rnd, 812_000 + Math.floor(rnd() * 8_000)), n1 = mutate(rnd, n0), p0 = published(n0), p1 = published(n1);
    if (p0.bids.usd.length < n0.bids.size) merged++;
    const tr = new BookCueTracker(open);
    tr.observe([pubBook(ID, 1_000, p0)], [ID], tiny(1_000));
    const events = tr.observe([pubBook(ID, 2_000, p1)], [ID], tiny(2_000));
    const a = zoneOf(p0, G), b = zoneOf(p1, G);
    for (const side of ['bid', 'ask'] as const) {
      const from = side === 'bid' ? Math.max(a.z0, b.z0) : Math.max(a.z0, b.z0, a.bidBin, b.bidBin), to = side === 'bid' ? Math.min(a.z1, b.z1, a.askBin, b.askBin) : Math.min(a.z1, b.z1);
      const s0 = nativeSums(side === 'bid' ? n0.bids : n0.asks, G), s1 = nativeSums(side === 'bid' ? n1.bids : n1.asks, G);
      const expected = new Map<number, number>();
      for (let bin = from; bin <= to; bin++) { const d = (s1.get(bin) ?? 0) - (s0.get(bin) ?? 0); compared++; if (Math.abs(d) >= 0.5) { expected.set(bin, d); changed++; } }
      assert.deepEqual([...byBin(events, side)].sort((x, y) => x[0] - y[0]), [...expected].sort((x, y) => x[0] - y[0]), `trial ${trial} ${side}`);
    }
  }
  assert.ok(merged > 90 && compared > 40_000 && changed > 1_000, `merged ${merged}, compared ${compared}, changed ${changed}`);
});

test('a $10 add that moves a $100k merged bucket across a $25 row edge is one $10 event on the grid of 20, where a $25 grid sees the bucket jump', () => {
  const centre = 812_800, n0: Native = { bids: new Map(), asks: new Map(), centre };
  for (let k = 0; k <= 900; k++) { n0.bids.set(812_799 - 70 * k, 100_000); n0.asks.set(812_801 + 70 * k, 100_000); }
  n0.bids.set(810_253, 50_000); n0.bids.set(810_251, 50_000);                       // 81,025.3 and 81,025.1: one bucket of $100k at 81,025.1
  const n1 = cloneNative(n0); n1.bids.set(810_249, 10);                               // $10 at 81,024.9: the bucket is reported there from now on
  const p0 = published(n0), p1 = published(n1);
  const tr = new BookCueTracker(open);
  tr.observe([pubBook(ID, 1_000, p0)], [ID], tiny(1_000));
  const e = only(tr.observe([pubBook(ID, 2_000, p1)], [ID], tiny(2_000)));
  assert.deepEqual([e.side, e.lo, e.hi, e.usd, e.before], ['bid', 4_051 * G, 4_052 * G, 10, 400_000]);
  // On the $25 rows the same bucket was in row 3241 and is in row 3240: a naive comparison reads the whole bucket as pulled from one row and added to the next.
  const naive0 = sumsOf(p0.bids, 25), naive1 = sumsOf(p1.bids, 25);
  assert.equal(naive0.get(3_241)! - naive1.get(3_241)!, 100_000);
  assert.equal(naive1.get(3_240)! - naive0.get(3_240)!, 100_010);
  // The tracker's event is the $10 in the bin: the bucket never left it. The bin is thirteen grid steps from the mid, past where the merge keeps its finest
  // buckets (12.5), so it keeps no levels and the rows of $25 share the $10 by overlap: the $10 where the bin is, not the hop of the bucket.
  assert.equal(e.lv, undefined);
  assert.deepEqual(rowsOf([e], 25), [[3_240, 2.5], [3_241, 7.5]]);
  assert.deepEqual(rowsOf([e], 20), [[4_051, 10]], 'on a row of the same grid it is where it is');
  // Where levels are kept out there (a tuning of a large number) the rows follow the bar, which hopped when the merge reported the bucket on the other side
  // of 81,025: -$100k on the one row and +$100,010 on the next, for a $10 change. That is what the limit is for.
  const kept = new BookCueTracker({ ...open, lvSteps: 1e9 });
  kept.observe([pubBook(ID, 1_000, p0)], [ID], tiny(1_000));
  const hop = only(kept.observe([pubBook(ID, 2_000, p1)], [ID], tiny(2_000)));
  assert.deepEqual(rowsOf([hop], 25), [[3_240, 100_010], [3_241, -100_000]]);
});

// ---- Banded books ----

const bands = (rows: [number, number, number][]): SideArrays => ({ lo: Float64Array.from(rows, r => r[0]), hi: Float64Array.from(rows, r => r[1]), usd: Float64Array.from(rows, r => r[2]) });
type BandEdit = Record<number, number | null>;
const HL = 'hyperliquid:BTC';
/**
 * Hyperliquid-like: 100-wide bands (a bid group by its lower edge, an ask group by its upper), the top bid and ask groups sharing [81,200, 81,300)
 * and cut at the touch (81,250), `touch` the span of the two. The edits are by lower edge: a number sets a band, null removes it.
 */
const hl = (ts: number, o: { bid?: BandEdit; ask?: BandEdit; topBid?: number; topAsk?: number; shift?: number } = {}): CueBook => {
  const shift = o.shift ?? 0, bid = new Map<number, number>(), ask = new Map<number, number>();
  for (let k = 1; k <= 15; k++) bid.set(81_200 - 100 * k, 2_000_000);
  for (let k = 0; k <= 14; k++) ask.set(81_300 + 100 * k, 2_000_000);
  for (const [map, edit] of [[bid, o.bid], [ask, o.ask]] as const) if (edit) for (const [lo, usd] of Object.entries(edit)) { if (usd === null) map.delete(Number(lo)); else map.set(Number(lo), usd); }
  const bidRows: [number, number, number][] = [[81_200, 81_250, o.topBid ?? 3_000_000], ...[...bid].sort((a, b) => b[0] - a[0]).map(([lo, usd]) => [lo, lo + 100, usd] as [number, number, number])];
  const askRows: [number, number, number][] = [[81_250, 81_300, o.topAsk ?? 3_000_000], ...[...ask].sort((a, b) => a[0] - b[0]).map(([lo, usd]) => [lo, lo + 100, usd] as [number, number, number])];
  const sh = (rows: [number, number, number][]): [number, number, number][] => rows.map(([lo, hi, usd]) => [lo + shift, hi + shift, usd]);
  return { id: HL, timestamp: ts, coarse: true, bids: bands(sh(bidRows)), asks: bands(sh(askRows)), touch: { lo: 81_200 + shift, hi: 81_300 + shift } };
};

test('a band is compared with the same band of the last publication: its cell is the band, flagged, and its grid is 0', () => {
  const tr = new BookCueTracker();
  assert.deepEqual(tr.observe([hl(1_000)], [HL], ctx(1_000)), []);
  const e = only(tr.observe([hl(2_000, { bid: { 81_000: 4_000_000 } })], [HL], ctx(2_000)));
  assert.deepEqual({ side: e.side, lo: e.lo, hi: e.hi, grid: e.grid, band: e.band, usd: e.usd, before: e.before, after: e.after, approx: e.approx }, { side: 'bid', lo: 81_000, hi: 81_100, grid: 0, band: true, usd: 2_000_000, before: 2_000_000, after: 4_000_000, approx: false });
  assert.equal(tr.recent(HL, 'bid', 81_020, 81_030), e, 'the hover finds it by any price inside the band');
  assert.equal(tr.recent(HL, 'ask', 81_020, 81_030), null);
});

test('a banded book\'s events come price ascending, bids before asks, with seq along them', () => {
  const tr = new BookCueTracker();
  tr.observe([hl(1_000)], [HL], ctx(1_000));
  const events = tr.observe([hl(2_000, { bid: { 80_000: 4_000_000, 80_800: null, 79_900: 4_500_000 }, ask: { 82_000: 4_000_000, 81_500: null } })], [HL], ctx(2_000));
  assert.deepEqual(events.map(e => [e.side, e.lo]), [['bid', 79_900], ['bid', 80_000], ['bid', 80_800], ['ask', 81_500], ['ask', 82_000]]);
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4, 5]);
});

test('the bands that overlap the touch span, in either publication, are never compared', () => {
  const tr = new BookCueTracker();
  tr.observe([hl(1_000)], [HL], ctx(1_000));
  assert.deepEqual(tr.observe([hl(2_000, { topBid: 9_000_000, topAsk: 100_000 })], [HL], ctx(2_000)), []);
  // The touch moves up a band: the band it left is compared again from the next publication, not out of the touch's own jitter.
  const moved = hl(3_000, { topBid: 3_000_000, topAsk: 3_000_000 });
  assert.deepEqual(tr.observe([moved], [HL], ctx(3_000)), []);
  assert.equal(tr.heat(HL, 'bid', 81_200, 81_250, 3_000)!.unknown, 1, 'what is in the touch is of unknown provenance');
});

test('a band that went empty inside the range the book reaches is a removal; one past the reach is unknown, and one that was missing and appears is an addition', () => {
  const l = hl(1_000, { bid: { 80_500: null } });                                  // a hole in the middle of the bids
  const tr = new BookCueTracker();
  tr.observe([l], [HL], ctx(1_000));
  const gone = tr.observe([hl(2_000, { bid: { 80_500: 2_500_000, 80_900: null } })], [HL], ctx(2_000));
  assert.deepEqual(gone.map(e => [e.side, e.lo, e.usd, e.added, e.removed]), [['bid', 80_500, 2_500_000, true, false], ['bid', 80_900, -2_000_000, false, true]]);
  // The outermost band (79,700) leaves with the venue's depth moving in: nothing was pulled.
  assert.deepEqual(tr.observe([hl(3_000, { bid: { 80_500: 2_500_000, 80_900: null, 79_700: null } })], [HL], ctx(3_000)), []);
  // A band that went empty comes back: it is an addition, not a new band.
  const back = only(tr.observe([hl(4_000, { bid: { 80_500: 2_500_000, 79_700: null } })], [HL], ctx(4_000)));
  assert.deepEqual([back.lo, back.usd, back.added], [80_900, 2_000_000, true]);
});

test('a band that went empty is kept for a minute (its last event stays for the hover), and its return is an addition either way: the range it was in was known to be empty', () => {
  const run = (gap: number): { remembered: CueEvent | null; back: CueEvent[] } => {
    const tr = new BookCueTracker();
    tr.observe([hl(0)], [HL], ctx(0));
    tr.observe([hl(5_400, { bid: { 80_900: null } })], [HL], ctx(5_400));         // gone (a removal event)
    let wall = 5_400;
    while (wall + 5_400 < 5_400 + gap) { wall += 5_400; tr.observe([hl(wall, { bid: { 80_900: null } })], [HL], ctx(wall)); }
    const remembered = tr.recent(HL, 'bid', 80_900, 81_000);
    wall += 5_400;
    return { remembered, back: tr.observe([hl(wall)], [HL], ctx(wall)) };         // and back
  };
  const soon = run(30_000), late = run(70_000);
  assert.deepEqual([soon.remembered?.removed, soon.remembered?.usd], [true, -2_000_000], 'thirty seconds on, the removal is still the band\'s last event');
  assert.equal(late.remembered, null, 'seventy seconds on, it is forgotten');
  for (const r of [soon, late]) assert.deepEqual(r.back.map(e => [e.lo, e.added, e.usd]), [[80_900, true, 2_000_000]]);
});

test('a venue that changes its grouping (every edge new) is a baseline, not the pull of everything', () => {
  const tr = new BookCueTracker();
  tr.observe([hl(1_000)], [HL], ctx(1_000));
  assert.deepEqual(tr.observe([hl(2_000, { shift: 37 })], [HL], ctx(2_000)), []);
  assert.equal(tr.stats.baselines, 2);
  assert.equal(only(tr.observe([hl(3_000, { shift: 37, bid: { 81_000: 4_000_000 } })], [HL], ctx(3_000))).lo, 81_037);
});

test('a book that publishes every 5.4 s is compared on each publication and is never started again', () => {
  const tr = new BookCueTracker(); let raised = 0;
  for (let k = 0; k < 14; k++) raised += tr.observe([hl(k * 5_400, { bid: { 81_000: k % 2 ? 4_000_000 : 2_000_000 } })], [HL], ctx(k * 5_400)).length;
  assert.equal(raised, 13, 'every publication after the first changed the band by $2M');
  assert.equal(tr.stats.baselines, 1);
  assert.ok(Math.abs(tr.info(HL)!.cadenceMs - 5_400) < 1);
  assert.deepEqual(tr.info(HL)!.zone, { lo: 79_700, hi: 82_800 });
});

test('a banded book that changed with its stamp unchanged was revalued by the touch hint: no publication, no confirmation, no step of its rhythm', () => {
  const tr = new BookCueTracker();
  tr.observe([hl(1_000)], [HL], ctx(1_000));
  // A weak change at the next real publication: $200k on a band of $2M is over the gate (5 % of the mean band), under three of it.
  assert.deepEqual(tr.observe([hl(6_400, { bid: { 81_000: 2_200_000 } })], [HL], ctx(6_400)), []);
  // The hint moves the cut inside the top groups: the stamp is the same, the top bands differ, nothing else does.
  const hint = { bid: { 81_000: 2_200_000 }, topBid: 3_300_000, topAsk: 2_700_000 };
  assert.deepEqual(tr.observe([hl(6_400, hint)], [HL], ctx(7_400)), []);
  assert.deepEqual([tr.stats.hints, tr.info(HL)!.observations, tr.stats.weakDropped, tr.stats.events], [1, 2, 0, 0], 'the change is still waiting');
  // The next real publication confirms it, measured from the publication before the weak change.
  const e = only(tr.observe([hl(11_800, { bid: { 81_000: 2_200_100 } })], [HL], ctx(11_800)));
  assert.deepEqual([e.confirmed, e.usd, e.prevWall, e.wall], [true, 200_100, 1_000, 11_800]);
  assert.ok(Math.abs(tr.info(HL)!.cadenceMs - 5_400) < 1, 'the hint was no step of the rhythm');
  // A hint seen again is the same frame: it is not looked at twice.
  const again = { bid: { 81_000: 2_200_100 }, topBid: 3_300_000, topAsk: 2_700_000 };
  tr.observe([hl(11_800, again)], [HL], ctx(12_000));
  const hints = tr.stats.hints;
  tr.observe([hl(11_800, again)], [HL], ctx(12_250));
  assert.equal(tr.stats.hints, hints);
  // A point book is different: a changed book with the same stamp is a publication (a far book that arrived, a venue that stamps by the second).
  const l = ladder(), big = copy(l); big.asks.set(MID + 4, 3_000_000);
  const pt = new BookCueTracker();
  pt.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.equal(only(pt.observe([book(ID, 1_000, big)], [ID], ctx(1_250))).usd, 2_000_000);
  assert.equal(pt.stats.hints, 0);
});

test('a band keeps its estimates: the share that is recent, the share that is unknown, the part of a band a row covers', () => {
  const tr = new BookCueTracker();
  tr.observe([hl(1_000)], [HL], ctx(1_000));
  assert.deepEqual(tr.heat(HL, 'bid', 81_000, 81_100, 1_000), { fresh: 0, unknown: 1, activity: 0 });
  tr.observe([hl(2_000, { bid: { 81_000: 4_000_000 } })], [HL], ctx(2_000));
  const h = tr.heat(HL, 'bid', 81_000, 81_050, 2_000)!;                             // half the band: the same shares
  assert.ok(Math.abs(h.fresh - 0.5) < 1e-12 && Math.abs(h.unknown - 0.5) < 1e-12);
  assert.ok(Math.abs(h.activity - (1 - Math.exp(-0.5))) < 1e-12);
  assert.equal(tr.heat(HL, 'bid', 50_000, 50_100, 2_000), null, 'no band there');
});

// ---- Where in time an event rests ----

test('an event carries the wall time of the publication it is measured from: where a trade that explains it can have happened', () => {
  const l = ladder(), tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const big = copy(l); big.bids.set(MID - 3, 2_000_000);
  const first = only(tr.observe([book(ID, 2_500, big)], [ID], ctx(2_500)));
  assert.deepEqual([first.prevWall, first.wall], [1_000, 2_500]);
  const big2 = copy(big); big2.bids.set(MID - 3, 4_000_000);
  const second = only(tr.observe([book(ID, 3_000, big2)], [ID], ctx(3_000)));
  assert.deepEqual([second.prevWall, second.wall], [2_500, 3_000], 'the publication just before');
  // A repeated frame is no publication: it moves nothing.
  tr.observe([book(ID, 3_000, big2)], [ID], ctx(3_250));
  const big3 = copy(big2); big3.bids.set(MID - 3, 6_000_000);
  assert.equal(only(tr.observe([book(ID, 4_000, big3)], [ID], ctx(4_000))).prevWall, 3_000);
});

test('a confirmed event, and one measured from the value before a weak change, rest on the publication that value was in', () => {
  const l = ladder(), at = (usd: number): Ladder => { const x = copy(l); x.asks.set(MID + 5, usd); return x; };
  let tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([book(ID, 2_000, at(1_100_000))], [ID], ctx(2_000)), []);
  const confirmed = only(tr.observe([book(ID, 3_000, at(1_100_000 + 0.5))], [ID], ctx(3_000)));
  assert.deepEqual([confirmed.confirmed, confirmed.prevWall, confirmed.wall], [true, 1_000, 3_000]);
  // Waiting at 2 s, dropped at 3 s by a move the other way that is itself weak (and waits from the same old value), confirmed at 4 s.
  tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([book(ID, 2_000, at(1_100_000))], [ID], ctx(2_000)), []);
  assert.deepEqual(tr.observe([book(ID, 3_000, at(920_000))], [ID], ctx(3_000)), []);
  const late = only(tr.observe([book(ID, 4_000, at(920_000.5))], [ID], ctx(4_000)));
  assert.deepEqual([late.usd, late.before, late.prevWall, late.wall], [-79_999.5, 1_000_000, 1_000, 4_000]);
  // Dropped by a large move the other way: it is measured from the same old value too.
  tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([book(ID, 2_000, at(1_100_000))], [ID], ctx(2_000)), []);
  const other = only(tr.observe([book(ID, 3_000, at(700_000))], [ID], ctx(3_000)));
  assert.deepEqual([other.usd, other.before, other.prevWall], [-300_000, 1_000_000, 1_000]);
});

test('a band\'s event and the row events made of it carry the stretch too, the earliest of those that meet in a row', () => {
  const tr = new BookCueTracker();
  tr.observe([hl(1_000)], [HL], ctx(1_000));
  const e = only(tr.observe([hl(6_400, { bid: { 81_000: 4_000_000 } })], [HL], ctx(6_400)));
  assert.deepEqual([e.prevWall, e.wall], [1_000, 6_400]);
  const rows = rowEvents([ev({ lo: 81_260, hi: 81_280, usd: 5, prevWall: 4_000, wall: 5_000 }), ev({ lo: 81_280, hi: 81_300, usd: 5, prevWall: 2_500, wall: 5_000 })], 100, 1_000_000);
  assert.deepEqual(rows.map(r => [r.prevWall, r.wall]), [[2_500, 5_000]]);
});

// ---- Pairs ----

test('opposite changes of the same size within two bins are one re-quote: both flagged, none dropped; a farther or unequal one is not', () => {
  const l = ladder();
  const requote = (dist: number, second = 2_000_000): CueEvent[] => {
    const tr = new BookCueTracker(); tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
    const next = copy(l); next.bids.delete(MID - 10); next.bids.set(MID - 10 - dist, second);
    return tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000));
  };
  for (const dist of [1, 2]) { const events = requote(dist); assert.deepEqual(events.map(e => [e.sign, e.pair]), [[1, true], [-1, true]], `${dist} bins over`); }
  assert.deepEqual(requote(PAIR_BINS + 1).map(e => e.pair), [false, false], 'three bins away');
  assert.deepEqual(requote(1, 1_300_000).map(e => e.pair), [false, false], 'a $1M removal and a $300k addition do not cancel');
  const tr = new BookCueTracker(); tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); next.bids.delete(MID - 10); next.bids.set(MID - 11, 2_000_000);
  tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000));
  assert.equal(tr.stats.pairs, 1);
});

test('a pair is matched nearest first and each event is in at most one', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); next.bids.delete(MID - 10); next.bids.set(MID - 11, 2_000_000); next.bids.delete(MID - 12);
  const events = tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000));
  assert.equal(events.length, 3);
  assert.equal(events.filter(e => e.pair).length, 2);
  assert.equal(tr.stats.pairs, 1);
});

test('nothing is netted across sides or across books', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book('a', 1_000, l), book('b', 1_000, l)], ['a', 'b'], ctx(1_000));
  const down = copy(l); down.bids.delete(MID - 10);                                // $1M off one bid
  const up = copy(l); up.bids.set(MID - 10, 2_000_000);                            // $1M on the same bid of another book
  const sided = copy(l); sided.bids.delete(MID - 1); sided.asks.set(MID, 2_000_000); // a bid gone and an ask added at the touch
  let events = tr.observe([book('a', 2_000, down), book('b', 2_000, up)], ['a', 'b'], ctx(2_000));
  assert.deepEqual(events.map(e => [e.id, e.sign, e.pair]), [['a', -1, false], ['b', 1, false]]);
  events = tr.observe([book('a', 3_000, sided), book('b', 3_000, up)], ['a', 'b'], ctx(3_000));
  assert.ok(events.length >= 2 && events.every(e => !e.pair));
  assert.equal(tr.stats.pairs, 0);
});

// ---- What a cell holds besides its size ----

const near = (a: number, b: number, what = ''): void => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);
const cell = (bin: number): [number, number] => [bin * G, (bin + 1) * G];

test('the estimates of a cell: unknown at first, an increase is recent, a decrease takes from the recent and the unknown in proportion, the recent cools', () => {
  const tr = new BookCueTracker(), l = ladder(), BIN = MID - 5, [lo, hi] = cell(BIN);
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.deepEqual(tr.heat(ID, 'bid', lo, hi, 1_000), { fresh: 0, unknown: 1, activity: 0 });
  const up = copy(l); up.bids.set(BIN, 1_500_000);                                   // +$500k
  tr.observe([book(ID, 2_000, up)], [ID], ctx(2_000));
  let h = tr.heat(ID, 'bid', lo, hi, 2_000)!;
  near(h.fresh, 0.5 / 1.5, 'fresh'); near(h.unknown, 1 / 1.5, 'unknown'); near(h.activity, 1 - Math.exp(-0.5 / 1.5), 'activity');
  // Cooling is analytic: no publication in between. The unknown share does not cool.
  h = tr.heat(ID, 'bid', lo, hi, 2_000 + TAU_FRESH_MS)!;
  near(h.fresh, (0.5 / 1.5) * Math.exp(-1), 'cooled'); near(h.unknown, 1 / 1.5, 'unknown, later');
  near(h.activity, 1 - Math.exp(-(0.5 * Math.exp(-TAU_FRESH_MS / TAU_ACTIVITY_MS)) / 1.5), 'activity, later');
  // Half of it goes a second after the first increase: the fresh and the unknown each lose half.
  const down = copy(up); down.bids.set(BIN, 750_000);
  tr.observe([book(ID, 3_000, down)], [ID], ctx(3_000));
  h = tr.heat(ID, 'bid', lo, hi, 3_000)!;
  near(h.fresh, 500_000 * Math.exp(-1_000 / TAU_FRESH_MS) * 0.5 / 750_000, 'fresh after the loss'); near(h.unknown, 500_000 / 750_000, 'unknown after the loss');
  // Everything goes: nothing left to be fresh or unknown of.
  const none = copy(down); none.bids.delete(BIN);
  tr.observe([book(ID, 4_000, none)], [ID], ctx(4_000));
  assert.deepEqual(tr.heat(ID, 'bid', lo, hi, 4_000), { fresh: 0, unknown: 0, activity: 0 });
  // And it comes back: all of it is recent.
  const back = copy(none); back.bids.set(BIN, 400_000);
  tr.observe([book(ID, 5_000, back)], [ID], ctx(5_000));
  h = tr.heat(ID, 'bid', lo, hi, 5_000)!;
  near(h.fresh, 1, 'a returned cell is recent'); near(h.unknown, 0, 'and not unknown');
});

test('freshGated leaves increases under the gate out of the recent increase: a cell that only jitters stays as it was, a real addition still counts', () => {
  const BIN = MID - 5, [lo, hi] = cell(BIN);
  const jitter = (freshGated: boolean): number => {
    const tr = new BookCueTracker({ freshGated }); let l = ladder();
    tr.observe([book(ID, 0, l)], [ID], ctx(0));
    for (let k = 1; k <= 40; k++) { l = copy(l); l.bids.set(BIN, k % 2 ? 1_030_000 : 1_000_000); tr.observe([book(ID, k * 1_000, l)], [ID], ctx(k * 1_000)); }
    return tr.heat(ID, 'bid', lo, hi, 40_000)!.fresh;
  };
  assert.ok(jitter(false) > 0.25, 'by default a jittering cell fills up with recent increases (each decrease takes only its share of them)');
  assert.equal(jitter(true), 0, 'gated: $30k against a gate of $50k never counts');
  const tr = new BookCueTracker({ freshGated: true }), l = ladder();
  tr.observe([book(ID, 0, l)], [ID], ctx(0));
  const up = copy(l); up.bids.set(BIN, 1_100_000);
  tr.observe([book(ID, 1_000, up)], [ID], ctx(1_000));
  near(tr.heat(ID, 'bid', lo, hi, 1_000)!.fresh, 0.1 / 1.1, 'a $100k increase is over the gate');
});

test('a cell that enters the zone is unknown, one that leaves it has no estimate, and a book that is not held has none', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const next = copy(l); for (let k = 0; k < 6; k++) next.asks.delete(MID + k);       // the mid goes up by 2.5 bins: the zone gets two bins at the top and loses three below
  tr.observe([book(ID, 2_000, next)], [ID], ctx(2_000));
  assert.deepEqual(tr.heat(ID, 'ask', ...cell(MID + 250), 2_000), { fresh: 0, unknown: 1, activity: 0 });
  assert.equal(tr.heat(ID, 'bid', ...cell(MID - 249), 2_000), null, 'out of the zone now');
  assert.equal(tr.heat(ID, 'bid', ...cell(MID - 246), 2_000)!.unknown, 1, 'still in it, and a baseline for the book: unknown');
  assert.equal(tr.heat('nobody', 'bid', 0, 100, 2_000), null);
  assert.equal(tr.heat(ID, 'bid', 100, 100, 2_000), null, 'an empty interval');
});

test('a row takes the cells whose centre it holds, weighted by their size; a row finer than the grid takes the cell it lies in', () => {
  const tr = new BookCueTracker(), l = ladder(), A = MID - 5;
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const up = copy(l); up.bids.set(A, 1_500_000);
  tr.observe([book(ID, 2_000, up)], [ID], ctx(2_000));
  const both = tr.heat(ID, 'bid', A * G, (A + 2) * G, 2_000)!;                       // bins A (1.5M, 0.5M recent) and A + 1 (1M, none)
  near(both.fresh, 0.5 / 2.5); near(both.unknown, 2 / 2.5);
  assert.deepEqual(tr.heat(ID, 'bid', (A + 0.5) * G, (A + 1.5) * G, 2_000), tr.heat(ID, 'bid', ...cell(A), 2_000), 'a row [centre, centre + grid) holds one centre');
  near(tr.heat(ID, 'bid', A * G + 5, A * G + 10, 2_000)!.fresh, 0.5 / 1.5, 'five dollars of a twenty-dollar bin');
  assert.equal(tr.heat(ID, 'ask', ...cell(A), 2_000), null, 'the ask side of that price is not a cell of the book');
});

test('the estimates stay inside their bounds over a long random run', () => {
  const rnd = rng(5), tr = new BookCueTracker(open), BIN = MID - 20, [lo, hi] = cell(BIN);
  let usd = 1_000_000;
  tr.observe([book(ID, 0, ladder())], [ID], tiny(0));
  for (let k = 1; k <= 400; k++) {
    usd = rnd() < 0.15 ? 0 : rnd() < 0.5 ? usd * (0.4 + rnd() * 1.4) : 1_000 + rnd() * 3_000_000;
    const l = ladder(); if (usd > 0) l.bids.set(BIN, Math.round(usd)); else l.bids.delete(BIN);
    tr.observe([book(ID, k * 1_000, l)], [ID], tiny(k * 1_000));
    for (const dt of [0, 5_000, 90_000]) {
      const h = tr.heat(ID, 'bid', lo, hi, k * 1_000 + dt)!;
      assert.ok(h.fresh >= 0 && h.unknown >= 0 && h.fresh + h.unknown <= 1 + 1e-9 && h.activity >= 0 && h.activity <= 1, `${k}: ${JSON.stringify(h)}`);
    }
  }
});

test('recent finds the newest event on a side that overlaps the interval, and nothing for another side or place', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const a = copy(l); a.bids.set(MID - 3, 2_000_000);
  const first = only(tr.observe([book(ID, 2_000, a)], [ID], ctx(2_000)));
  assert.equal(tr.recent(ID, 'bid', ...cell(MID - 3)), first);
  assert.equal(tr.recent(ID, 'bid', (MID - 5) * G, (MID - 1) * G), first, 'by any interval that overlaps it');
  assert.equal(tr.recent(ID, 'ask', ...cell(MID - 3)), null);
  assert.equal(tr.recent(ID, 'bid', ...cell(MID - 4)), null);
  assert.equal(tr.recent('nobody', 'bid', 0, 1e9), null);
  const b = copy(a); b.bids.set(MID - 3, 500_000);
  const second = only(tr.observe([book(ID, 3_000, b)], [ID], ctx(3_000)));
  assert.equal(tr.recent(ID, 'bid', ...cell(MID - 3)), second, 'the newer one replaces it in its cell');
  const c = copy(b); c.bids.set(MID - 4, 3_000_000);
  const third = only(tr.observe([book(ID, 4_000, c)], [ID], ctx(4_000)));
  assert.equal(tr.recent(ID, 'bid', (MID - 5) * G, (MID - 1) * G), third, 'of several, the newest');
});

// ---- Events on display rows ----

const ev = (o: Partial<CueEvent>): CueEvent => ({ id: ID, side: 'bid', lo: 0, hi: 0, grid: G, sign: 1, usd: 0, before: 0, after: 0, strength: 0, wall: 1_000, prevWall: 0, seq: 1, pub: 1, removed: false, added: false, pair: false, approx: false, band: false, confirmed: false, ...o });

test('a cell on rows coarser than the grid: whole in one row, or shared between two by overlap, the USD kept', () => {
  const e = ev({ lo: 81_280, hi: 81_300, usd: 1_000_000, seq: 7 });
  assert.deepEqual(rowEvents([e], 100, 1_000_000).map(r => [r.row, r.usd, r.seq]), [[812, 1_000_000, 7]]);
  const r = rowEvents([e], 100, 1_000_000)[0]!;
  near(r.strength, 1 - Math.exp(-1));
  const straddle = ev({ lo: 81_240, hi: 81_260, usd: -800_000 });
  assert.deepEqual(rowEvents([straddle], 50, 1_000_000).map(x => [x.row, x.usd]), [[1_624, -400_000], [1_625, -400_000]]);
  assert.deepEqual(rowEvents([straddle], 25, 1_000_000).map(x => [x.row, x.usd]), [[3_249, -400_000], [3_250, -400_000]], 'ten and ten of the twenty dollars');
  const uneven = ev({ lo: 81_260, hi: 81_280, usd: -800_000 });
  assert.deepEqual(rowEvents([uneven], 25, 1_000_000).map(x => [x.row, x.usd]), [[3_250, -600_000], [3_251, -200_000]], 'fifteen and five: three quarters and one');
});

test('a cell on rows finer than the grid is shared by the rows it covers, and the shares add up to the whole', () => {
  const e = ev({ lo: 81_280, hi: 81_300, usd: 1_000_000, removed: true });
  const rows = rowEvents([e], 5, 1_000_000);
  assert.deepEqual(rows.map(r => [r.row, r.usd]), [[16_256, 250_000], [16_257, 250_000], [16_258, 250_000], [16_259, 250_000]]);
  assert.ok(rows.every(r => r.removed));
  near(rows.reduce((s, r) => s + r.usd, 0), 1_000_000);
  near(rows[0]!.strength, 1 - Math.exp(-0.25));
});

test('events of one book, side and publication that meet in a row are one: summed, strength from the sum, flags together', () => {
  const a = ev({ lo: 81_260, hi: 81_280, usd: 600_000, seq: 3, removed: true, pair: true }), b = ev({ lo: 81_280, hi: 81_300, usd: -900_000, seq: 5, removed: true });
  const rows = rowEvents([a, b], 100, 1_000_000);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.row, rows[0]!.usd, rows[0]!.seq, rows[0]!.removed, rows[0]!.pair], [812, -300_000, 5, true, true]);
  near(rows[0]!.strength, 1 - Math.exp(-0.3));
  // Not one when the publication, the side or the book differs.
  assert.equal(rowEvents([a, { ...b, wall: 2_000 }], 100, 1_000_000).length, 2);
  assert.equal(rowEvents([a, { ...b, pub: 2 }], 100, 1_000_000).length, 2, 'the wall of another publication may come round to the same value');
  assert.equal(rowEvents([a, { ...b, side: 'ask' }], 100, 1_000_000).length, 2);
  assert.equal(rowEvents([a, { ...b, id: 'other' }], 100, 1_000_000).length, 2);
  const mixed = rowEvents([ev({ lo: 81_260, hi: 81_280, usd: 100, removed: true }), ev({ lo: 81_280, hi: 81_300, usd: 100, removed: false })], 100, 1_000_000);
  assert.equal(mixed[0]!.removed, false, 'removed only when every part of the row says so');
});

test('a band is shared over the rows it covers in proportion, as the spreader shares a band', () => {
  const band = ev({ lo: 81_100, hi: 81_200, grid: 0, usd: 2_000_000, band: true });
  assert.deepEqual(rowEvents([band], 50, 1_000_000).map(r => [r.row, r.usd, r.band]), [[1_622, 1_000_000, true], [1_623, 1_000_000, true]]);
  assert.deepEqual(rowEvents([band], 25, 1_000_000).map(r => r.usd), [500_000, 500_000, 500_000, 500_000]);
  assert.deepEqual(rowEvents([band], 400, 1_000_000).map(r => [r.row, r.usd]), [[202, 2_000_000]], 'one row holds it whole');
  assert.deepEqual(rowEvents([ev({ lo: 81_000, hi: 81_400, grid: 0, usd: 400_000, band: true })], 100, 1_000_000).map(r => [r.row, r.usd]), [[810, 100_000], [811, 100_000], [812, 100_000], [813, 100_000]]);
});

test('rows can be limited to a window, an event never makes more than 4,096, and bad steps or sizes make none', () => {
  const band = ev({ lo: 81_000, hi: 81_400, grid: 0, usd: 400_000, band: true });
  // A window keeps its rows and one more either side (whoever asks cuts the rest): [811, 812] and 810 and 813.
  assert.deepEqual(rowEvents([band], 100, 1_000_000, { lo: 81_100, hi: 81_299 }).map(r => r.row), [810, 811, 812, 813]);
  assert.deepEqual(rowEvents([band], 100, 1_000_000, { lo: 81_200, hi: 81_299 }).map(r => r.row), [811, 812, 813], 'row 810 is two rows from the window');
  assert.deepEqual(rowEvents([band], 100, 1_000_000, { lo: 81_300, hi: 81_399 }).map(r => r.row), [812, 813], 'and the band ends at 813');
  assert.deepEqual(rowEvents([band], 100, 1_000_000, { lo: 81_500, hi: 81_599 }).map(r => r.row), [], 'a window the band does not reach, with its margin, has none');
  assert.equal(rowEvents([ev({ lo: 0, hi: 1e6, usd: 1 })], 1, 1_000_000).length, 4_096);
  for (const step of [0, -5, Number.NaN, Infinity]) assert.deepEqual(rowEvents([ev({ lo: 0, hi: 20, usd: 1 })], step, 1_000_000), []);
  assert.deepEqual(rowEvents([ev({ lo: 20, hi: 20, usd: 1 }), ev({ lo: 30, hi: 10, usd: 1 })], 10, 1_000_000), [], 'no width, no rows');
  assert.ok(rowEvents([ev({ lo: 0, hi: 20, usd: 5_000_000 })], 20, 0)[0]!.strength > 0.99, 'a scale of zero falls back to the default reference');
  assert.deepEqual(rowEvents([], 20, 1_000_000), []);
});

test('whatever the rows, the USD of the events is the USD of the rows', () => {
  const rnd = rng(9);
  for (let trial = 0; trial < 200; trial++) {
    const step = [1, 2.5, 5, 7, 20, 25, 50, 100, 333][Math.floor(rnd() * 9)]!, g = rnd() < 0.5 ? 20 : 0;
    const events = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => {
      const lo = g ? Math.floor(rnd() * 400) * g : 81_000 + rnd() * 300, width = g || 1 + rnd() * 250;
      return ev({ lo, hi: lo + width, grid: g, usd: (rnd() - 0.5) * 3e6, seq: i + 1, band: !g });
    });
    near(rowEvents(events, step, 1e6).reduce((s, r) => s + r.usd, 0) / 1e6, events.reduce((s, e) => s + e.usd, 0) / 1e6, `trial ${trial} step ${step}`);
  }
});

// ---- What must not break it ----

test('malformed books never throw and are never compared from', () => {
  const empty: SideArrays = { lo: new Float64Array(0), hi: new Float64Array(0), usd: new Float64Array(0) };
  const side = (lo: number[], hi: number[], usd: number[]): SideArrays => ({ lo: Float64Array.from(lo), hi: Float64Array.from(hi), usd: Float64Array.from(usd) });
  const good = ladder(), tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, good)], [ID], ctx(1_000));
  const bad: CueBook[] = [
    { id: ID, timestamp: Number.NaN, coarse: false, step: G, bids: side([Number.NaN, -5, 0], [Number.NaN, -5, 0], [10, 10, 10]), asks: empty },
    { id: ID, timestamp: 2_000, coarse: false, step: G, bids: side([1, 2], [1], [5, 5, 5]), asks: side([3], [3, 3], [5]) },
    { id: ID, timestamp: 3_000, coarse: false, step: G, bids: side([81_270, 81_250], [81_270, 81_250], [Infinity, -4]), asks: side([81_290], [81_290], [Number.NaN]) },
    { id: ID, timestamp: 4_000, coarse: false, step: G, bids: side([81_270], [81_260], [1e6]), asks: side([81_290], [81_290], [1e6]) },     // hi under lo
    { id: ID, timestamp: 5_000, coarse: false, step: -1, bids: empty, asks: empty },
    { id: ID, timestamp: 6_000, coarse: true, bids: empty, asks: empty },
    { id: ID, timestamp: 7_000, coarse: true, bids: side([1e300], [Infinity], [1e6]), asks: side([-1], [0], [1e6]) },
  ];
  for (const b of bad) assert.deepEqual(tr.observe([b], [ID], ctx(b.timestamp || 1)), []);
  assert.deepEqual(tr.observe([undefined as unknown as CueBook, null as unknown as CueBook], [ID], ctx(8_000)), []);
  assert.deepEqual(tr.observe([book(ID, 9_000, good)], [ID], { wall: Number.NaN, scale: 1, floorUsd: 1 }), [], 'no clock, no frame');
  assert.equal(tr.stats.errors, 0);
  assert.equal(tr.info(ID)!.usable, false);
  // A good book after all that is a baseline, and then it is compared again; a scale or a floor that is not a number does not stop it.
  assert.deepEqual(tr.observe([book(ID, 10_000, good)], [ID], ctx(10_000)), []);
  const next = copy(good); next.bids.set(MID - 3, 3_000_000);
  const e = only(tr.observe([book(ID, 11_000, next)], [ID], { wall: 11_000, scale: Number.NaN, floorUsd: Number.NaN }));
  assert.ok(e.strength > 0.8 && e.strength < 0.9, 'the default reference size');
});

test('a book whose arrays are missing is counted as an error and starts the book again, and nothing else is stopped by it', () => {
  const tr = new BookCueTracker(), l = ladder(), other = 'other';
  tr.observe([book(ID, 1_000, l), book(other, 1_000, l)], [ID, other], ctx(1_000));
  const broken = { id: ID, timestamp: 2_000, coarse: false, step: G, bids: undefined, asks: undefined } as unknown as CueBook;
  const big = copy(l); big.asks.set(MID + 4, 3_000_000);
  const events = tr.observe([broken, book(other, 2_000, big)], [ID, other], ctx(2_000));
  assert.deepEqual(events.map(e => e.id), [other], 'the other book was read');
  assert.equal(tr.stats.errors, 1);
  assert.deepEqual(tr.observe([book(ID, 3_000, big)], [ID], ctx(3_000)), [], 'the broken book starts again');
  assert.equal(only(tr.observe([book(ID, 4_000, (() => { const x = copy(big); x.asks.set(MID + 4, 5_000_000); return x; })())], [ID], ctx(4_000))).usd, 2_000_000);
});

test('a weak change waiting when its cell stops being comparable is dropped, and is never raised later', () => {
  const tr = new BookCueTracker(), l = ladder(1_000_000, 40);                      // asks MID .. MID + 39
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const weak = copy(l); weak.asks.set(MID + 5, 1_100_000);
  assert.deepEqual(tr.observe([book(ID, 2_000, weak)], [ID], ctx(2_000)), []);
  const shorter = copy(weak); for (let k = 4; k < 40; k++) shorter.asks.delete(MID + k);   // the depth limit comes in past the cell
  assert.deepEqual(tr.observe([book(ID, 3_000, shorter)], [ID], ctx(3_000)), []);
  assert.equal(tr.stats.weakDropped, 1);
  assert.deepEqual(tr.observe([book(ID, 4_000, weak)], [ID], ctx(4_000)), [], 'the cell is back as a baseline: the change that waited is gone');
  assert.deepEqual(tr.observe([book(ID, 5_000, nudge(weak))], [ID], ctx(5_000)), []);
});

test('a book that has only ever been broken holds no estimate', () => {
  const tr = new BookCueTracker();
  const nothing: SideArrays = { lo: new Float64Array(0), hi: new Float64Array(0), usd: new Float64Array(0) };
  assert.deepEqual(tr.observe([{ id: ID, timestamp: 1, coarse: false, bids: nothing, asks: nothing }], [ID], ctx(1_000)), []);
  assert.equal(tr.heat(ID, 'bid', 0, 1e9, 1_000), null);
  assert.equal(tr.recent(ID, 'bid', 0, 1e9), null);
  assert.equal(tr.info(ID)!.usable, false);
});

test('the state does not grow: the same cells after ten minutes of a market that drifts, jumps and re-quotes', () => {
  const rnd = rng(3), tr = new BookCueTracker();
  let mid = MID, size = tr.size();
  for (let t = 0; t < 600; t++) {
    mid += Math.round((rnd() - 0.5) * 6); if (t === 200) mid += 700; if (t === 400) mid -= 40;
    const a = ladder(1_000_000 + Math.round(rnd() * 100_000), 300, mid), b = ladder(800_000, 300, mid + 3);
    for (let k = 0; k < 5; k++) { a.bids.set(mid - 1 - Math.floor(rnd() * 60), Math.round(rnd() * 3_000_000)); b.asks.set(mid + 3 + Math.floor(rnd() * 60), Math.round(rnd() * 3_000_000)); }
    const events = tr.observe([book('a', t * 1_000, a), book('b', t * 1_000, b)], ['a', 'b'], ctx(t * 1_000));
    assert.ok(events.length < 400, 'a frame never raises more than its books hold');
    if (t === 5) size = tr.size(); else if (t > 5) assert.deepEqual(tr.size(), size, `second ${t}`);
  }
  // Two books of two sides of 518 cells, and the events they can keep for the hover: CUE_HISTORY (4) a cell, however many publications there were.
  assert.equal(CUE_HISTORY, 4);
  assert.deepEqual(size, { books: 2, bins: 2 * 2 * (2 * ZONE_STEPS + 2 * 8 + 4), bands: 0, slots: 2 * 2 * (2 * ZONE_STEPS + 2 * 8 + 4) * CUE_HISTORY });
  assert.equal(tr.stats.errors, 0);
});

test('a banded book keeps no more bands than it shows and the ones that went empty in the last minute', () => {
  const tr = new BookCueTracker(), rnd = rng(4);
  let peak = 0;
  for (let k = 0; k < 120; k++) {
    // The bands come and go at random, and every 20 publications the whole grouping moves up by a band.
    const shift = Math.floor(k / 20) * 100, bid: BandEdit = {}, ask: BandEdit = {};
    for (let j = 1; j <= 15; j++) { if (rnd() < 0.25) bid[81_200 - 100 * j] = rnd() < 0.5 ? null : 1_000_000 + Math.round(rnd() * 2_000_000); if (rnd() < 0.25) ask[81_300 + 100 * (j - 1)] = rnd() < 0.5 ? null : 1_000_000 + Math.round(rnd() * 2_000_000); }
    tr.observe([hl(k * 5_400, { shift, bid, ask })], [HL], ctx(k * 5_400));
    peak = Math.max(peak, tr.size().bands);
  }
  assert.ok(peak <= 150, `peak ${peak}`);
  assert.equal(tr.stats.errors, 0);
});

test('events come in the frame\'s order of books, bids before asks, price ascending, with seq increasing over the whole run', () => {
  const tr = new BookCueTracker(), l = ladder(), seen: number[] = [];
  tr.observe([book('a', 1_000, l), book('b', 1_000, l)], ['b', 'a'], ctx(1_000));
  const next = copy(l); next.bids.set(MID - 9, 3_000_000); next.bids.set(MID - 3, 3_000_000); next.asks.set(MID + 7, 3_000_000); next.asks.set(MID + 2, 3_000_000);
  const events = tr.observe([book('a', 2_000, next), book('b', 2_000, next)], ['a', 'b'], ctx(2_000));
  assert.deepEqual(events.map(e => [e.id, e.side, e.lo / G]), [['a', 'bid', MID - 9], ['a', 'bid', MID - 3], ['a', 'ask', MID + 2], ['a', 'ask', MID + 7], ['b', 'bid', MID - 9], ['b', 'bid', MID - 3], ['b', 'ask', MID + 2], ['b', 'ask', MID + 7]]);
  seen.push(...events.map(e => e.seq));
  const more = copy(next); more.asks.set(MID + 5, 3_000_000);
  seen.push(...tr.observe([book('a', 3_000, more)], ['a'], ctx(3_000)).map(e => e.seq));
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a book that appears twice in a frame is read once, from its first copy', () => {
  const tr = new BookCueTracker(), l = ladder(), big = copy(l); big.asks.set(MID + 4, 3_000_000);
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([book(ID, 2_000, l), book(ID, 2_000, big)], [ID], ctx(2_000)), []);
  assert.equal(tr.stats.observations, 2, 'once a frame');
  assert.equal(tr.stats.distinct, 2);
});

test('the constants are the ones the notes and the studies name', () => {
  assert.deepEqual([TAU_FRESH_MS, TAU_ACTIVITY_MS, ZONE_STEPS, PAIR_BINS, MIN_GAP_MS, GAP_CADENCES, FORGET_MS], [45_000, 20_000, 249, 2, 8_000, 4, 30_000]);
  assert.equal(DEFAULT_TUNING.pairTolerance, 0.15); assert.equal(DEFAULT_TUNING.confirmRatio, 3); assert.equal(DEFAULT_TUNING.noiseHalfLifeMs, 20_000);
});

// ---- Regrouped bands, a venue that left the feed, a weak removal of a whole band, and the events a hover has to show (Sol's review of the integrated branch) ----

type Band = [number, number, number];
const bandBook = (ts: number, bid: Band[], ask: Band[]): CueBook => ({ id: HL, timestamp: ts, coarse: true, bids: bands(bid), asks: bands(ask) });
const MILLION = 1_000_000;
/** Ten-dollar bands of $1M from `first`, `count` of them, with the edits: a band by its lower edge, a number to set it, null to remove it. */
const run = (first: number, count: number, edit: Record<number, number | null> = {}): Band[] => {
  const out: Band[] = [];
  for (let k = 0; k < count; k++) { const lo = first + 10 * k, v = lo in edit ? edit[lo] : MILLION; if (v !== null && v !== undefined) out.push([lo, lo + 10, v]); }
  return out;
};
/** Bids [40, 90) and asks [100, 150) as five $1M bands each; `bid` is the bids as they are instead, `ask` the edits of the asks. */
const tenBands = (ts: number, o: { bid?: Band[]; edit?: Record<number, number | null> } = {}): CueBook => bandBook(ts, o.bid ?? run(40, 5, o.edit), run(100, 5));

test('a band regrouped by the venue (split, joined or an edge moved) is one region grouped differently: no addition and no pull, the new bands unknown', () => {
  const tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  // [80, 90) of $1M becomes [80, 85) and [85, 90) of $500k, the bands beside it as they were.
  const split: Band[] = [...run(40, 4), [80, 85, 500_000], [85, 90, 500_000]];
  assert.deepEqual(tr.observe([tenBands(2_000, { bid: split })], [HL], ctx(2_000)), []);
  assert.equal(tr.stats.baselines, 1, 'the representation heuristic does not start the book again, and the regrouping is no event');
  for (const [lo, hi] of [[80, 85], [85, 90]] as const) assert.deepEqual(tr.heat(HL, 'bid', lo, hi, 2_000), { fresh: 0, unknown: 1, activity: 0 });
  assert.equal(tr.size().bands, 6 + 5, 'the old band is gone');
  // Joined again: the same.
  assert.deepEqual(tr.observe([tenBands(3_000)], [HL], ctx(3_000)), []);
  assert.equal(tr.size().bands, 5 + 5);
  assert.deepEqual(tr.heat(HL, 'bid', 80, 90, 3_000), { fresh: 0, unknown: 1, activity: 0 });
  // An edge moved: [70, 80) and [80, 90) become [70, 82) and [82, 90).
  const moved: Band[] = [...run(40, 3), [70, 82, 1_200_000], [82, 90, 800_000]];
  assert.deepEqual(tr.observe([tenBands(4_000, { bid: moved })], [HL], ctx(4_000)), []);
  assert.equal(tr.stats.events, 0);
  // The bands that were not regrouped go on being compared: a change of one of them is an event.
  const changed: Band[] = [[40, 50, 3 * MILLION], ...moved.slice(1)];
  assert.equal(only(tr.observe([tenBands(5_000, { bid: changed })], [HL], ctx(5_000))).lo, 40);
});

test('a band that really is new, or really goes empty, with no neighbour regrouped is still an addition or a pull; and a regrouping beside one does not hide it', () => {
  let tr = new BookCueTracker();
  tr.observe([tenBands(1_000, { bid: run(40, 5, { 60: null }) })], [HL], ctx(1_000));      // a hole at [60, 70)
  const added = only(tr.observe([tenBands(2_000)], [HL], ctx(2_000)));
  assert.deepEqual([added.side, added.lo, added.hi, added.added, added.usd], ['bid', 60, 70, true, MILLION], 'a band inside the range the book reached, overlapping nothing that changed');
  tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  const gone = only(tr.observe([tenBands(2_000, { bid: run(40, 5, { 60: null }) })], [HL], ctx(2_000)));
  assert.deepEqual([gone.lo, gone.removed, gone.usd], [60, true, -MILLION]);
  // One band regrouped and another really gone in the same publication: only the second is an event.
  tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  const both: Band[] = [[40, 50, MILLION], [60, 70, MILLION], [70, 80, MILLION], [80, 85, 500_000], [85, 90, 500_000]];   // [50, 60) is gone
  assert.deepEqual(tr.observe([tenBands(2_000, { bid: both })], [HL], ctx(2_000)).map(e => [e.lo, e.removed]), [[50, true]]);
});

test('a change waiting on a band that is then regrouped is dropped', () => {
  const tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  assert.deepEqual(tr.observe([tenBands(2_000, { bid: run(40, 5, { 80: 1_080_000 }) })], [HL], ctx(2_000)), [], 'a weak change: waiting');
  assert.deepEqual(tr.observe([tenBands(3_000, { bid: [...run(40, 4), [80, 85, 540_000], [85, 90, 540_000]] })], [HL], ctx(3_000)), []);
  assert.equal(tr.stats.weakDropped, 1);
});

test('a venue that is asked for and left the frame starts again when it comes back; one that merely repeats does not, and one not asked for keeps the gap rule', () => {
  const l = ladder(), big = copy(l); big.asks.set(MID + 4, 3_000_000);
  const bigger = copy(big); bigger.asks.set(MID + 4, 5_000_000);
  const tr = new BookCueTracker();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_250)); tr.observe([book(ID, 1_000, l)], [ID], ctx(1_500));
  assert.equal(tr.info(ID)!.usable, true, 'repeated frames leave it as it is');
  tr.observe([], [ID], ctx(1_750));                                                     // asked for, and not in the frame
  assert.equal(tr.info(ID)!.usable, false);
  assert.equal(tr.heat(ID, 'ask', ...cell(MID + 4), 1_750), null);
  tr.observe([], [ID], ctx(2_000));                                                     // and again: nothing to clear twice
  assert.deepEqual(tr.observe([book(ID, 2_500, big)], [ID], ctx(2_500)), [], 'the replacement book is a baseline, whatever it shows');
  assert.equal(tr.stats.baselines, 2);
  assert.equal(only(tr.observe([book(ID, 3_500, bigger)], [ID], ctx(3_500))).usd, 2_000_000, 'compared from it from then on');
  // Not asked for: the same absence changes nothing (the reader hid the venue for a few seconds).
  const hidden = new BookCueTracker();
  hidden.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  for (const wall of [2_000, 3_000, 4_000]) hidden.observe([book(ID, 1_000, l)], [], ctx(wall));
  assert.equal(hidden.info(ID)!.usable, true);
  assert.equal(only(hidden.observe([book(ID, 5_000, big)], [ID], ctx(5_000))).usd, 2_000_000);
  // A banded book as well.
  const banded = new BookCueTracker();
  banded.observe([tenBands(1_000)], [HL], ctx(1_000));
  banded.observe([], [HL], ctx(1_500));
  assert.deepEqual(banded.observe([tenBands(6_400, { bid: run(40, 5, { 80: 4 * MILLION }) })], [HL], ctx(6_400)), []);
  assert.equal(banded.stats.baselines, 2);
});

test('a weak removal of a whole band is confirmed by the next publication that still omits it, and dropped when the band comes back', () => {
  // Five bid bands, the third of $100k among $1M ones: its removal is $100k against a gate of $50k (5 % of the mean band), under three of it.
  const asks = run(100, 5);
  const frame = (ts: number, omit: boolean): CueBook => bandBook(ts, [[40, 50, MILLION], [50, 60, MILLION], ...(omit ? [] : [[60, 70, 100_000] as Band]), [70, 80, MILLION], [80, 90, MILLION]], asks);
  const tr = new BookCueTracker();
  tr.observe([frame(1_000, false)], [HL], ctx(1_000));
  assert.deepEqual(tr.observe([frame(2_000, true)], [HL], ctx(2_000)), [], 'waiting');
  const e = only(tr.observe([frame(3_000, true)], [HL], ctx(3_000)));
  assert.deepEqual([e.lo, e.hi, e.before, e.usd, e.after, e.removed, e.confirmed, e.prevWall, e.wall], [60, 70, 100_000, -100_000, 0, true, true, 1_000, 3_000]);
  assert.deepEqual(tr.observe([frame(4_000, true)], [HL], ctx(4_000)), [], 'and only once');
  assert.equal(tr.stats.weakDropped, 0);
  // The band comes back at the next publication instead: the removal is dropped.
  const back = new BookCueTracker();
  back.observe([frame(1_000, false)], [HL], ctx(1_000));
  assert.deepEqual(back.observe([frame(2_000, true)], [HL], ctx(2_000)), []);
  assert.deepEqual(back.observe([frame(3_000, false)], [HL], ctx(3_000)), []);
  assert.equal(back.stats.weakDropped, 1);
  assert.equal(back.stats.events, 0);
});

test('recentEvents is the events of the newest publications that touch an interval, newest first, the newest being what a row\'s light was the sum of; recent stays the one newest cell', () => {
  const tr = new BookCueTracker(), l = ladder(), A = MID - 20;                        // bins A .. A + 3 are $80 wide together: A x 20 = 80,880 = 1,011 x 80
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const older = copy(l); older.bids.set(A + 3, 3_000_000);
  only(tr.observe([book(ID, 2_000, older)], [ID], ctx(2_000)));
  const together = copy(older); for (const k of [0, 1, 2]) together.bids.set(A + k, 2_000_000 + 500_000 * k);
  const lit = tr.observe([book(ID, 3_000, together)], [ID], ctx(3_000));
  assert.equal(lit.length, 3);
  const shown = tr.recentEvents(ID, 'bid', A * G, (A + 4) * G);
  assert.deepEqual(shown.map(e => [e.lo / G, e.usd, e.wall]), [[A, 1_000_000, 3_000], [A + 1, 1_500_000, 3_000], [A + 2, 2_000_000, 3_000], [A + 3, 2_000_000, 2_000]], 'the newest publication together, then the older change of the fourth bin');
  assert.equal(tr.recent(ID, 'bid', A * G, (A + 4) * G), lit[2], 'recent is the newest one cell');
  const row = rowEvents(shown.filter(e => e.wall === 3_000), 4 * G, 1_000_000), light = rowEvents(lit, 4 * G, 1_000_000);
  assert.deepEqual(row.map(r => [r.row, r.usd]), light.map(r => [r.row, r.usd]), 'the hover shows what the light used');
  assert.equal(row[0]!.usd, 4_500_000);
  // An interval holding only the older change gets that publication's events; none for another side, an unknown book, or an empty interval.
  assert.deepEqual(tr.recentEvents(ID, 'bid', (A + 3) * G, (A + 4) * G).map(e => [e.lo / G, e.wall]), [[A + 3, 2_000]]);
  assert.deepEqual(tr.recentEvents(ID, 'ask', A * G, (A + 4) * G), []);
  assert.deepEqual(tr.recentEvents('nobody', 'bid', 0, 1e9), []);
  assert.deepEqual(tr.recentEvents(ID, 'bid', 5, 5), []);
  // A confirmed event shares its publication with the large ones of that publication, and the publication before follows.
  const weak = copy(together); weak.asks.set(MID + 7, 1_100_000); weak.asks.set(MID + 9, 4_000_000);
  tr.observe([book(ID, 4_000, weak)], [ID], ctx(4_000));                               // $100k waits, $3M is raised
  const confirm = copy(weak); confirm.asks.set(MID + 7, 1_100_001); confirm.asks.set(MID + 8, 3_000_000);
  tr.observe([book(ID, 5_000, confirm)], [ID], ctx(5_000));
  assert.deepEqual(tr.recentEvents(ID, 'ask', (MID + 7) * G, (MID + 10) * G).map(e => [e.lo / G - MID, e.confirmed, e.wall]), [[7, true, 5_000], [8, false, 5_000], [9, false, 4_000]]);
});

test('a banded book\'s recentEvents are its cells\' events of the newest publications, newest first, price ascending in each', () => {
  const tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  tr.observe([tenBands(6_400, { bid: run(40, 5, { 40: 3 * MILLION }) })], [HL], ctx(6_400));
  tr.observe([tenBands(11_800, { bid: run(40, 5, { 40: 3 * MILLION, 80: 4 * MILLION, 60: 5 * MILLION }) })], [HL], ctx(11_800));
  assert.deepEqual(tr.recentEvents(HL, 'bid', 40, 90).map(e => [e.lo, e.wall]), [[60, 11_800], [80, 11_800], [40, 6_400]], 'the newest publication together, then the one before');
  assert.deepEqual(tr.recentEvents(HL, 'bid', 40, 50).map(e => [e.lo, e.wall]), [[40, 6_400]]);
});

// ---- Sol's round-B review: levels inside a bin, ghost keys, and a venue that left the frame ----

/** A venue's book from native levels in whole dollars (price to USD), merged by distance from its own mid on the grid, as the server publishes it. */
const venue = (ts: number, bids: Record<number, number>, asks: Record<number, number>, o: { step?: number | null; id?: string } = {}): CueBook => {
  const side = (m: Record<number, number>, bid: boolean): SideArrays => {
    const prices = Object.keys(m).map(Number).filter(p => m[p]! > 0).sort((a, b) => bid ? b - a : a - b);
    const lo = Float64Array.from(prices);
    return { lo, hi: lo, usd: Float64Array.from(prices, p => m[p]!) };
  };
  const b = side(bids, true), a = side(asks, false), mid = (b.lo[0]! + a.lo[0]!) / 2, step = o.step ?? G;       // a grid that is not published is the grid it is merged on
  const out: CueBook = { id: o.id ?? ID, timestamp: ts, coarse: false, bids: mergeByDistance(b, mid, step, true), asks: mergeByDistance(a, mid, step, false) };
  if (o.step !== null) out.step = step;
  return out;
};
/** $1M a level, `count` levels from `first`, a grid step apart: a ladder deep enough to be compared, with a mean cell of about $1M (a gate of about $50k). */
const fillBids = (first: number, count: number, m: Record<number, number> = {}): Record<number, number> => { for (let k = 0; k < count; k++) m[first - G * k] = 1_000_000; return m; };
const fillAsks = (first: number, count: number, m: Record<number, number> = {}): Record<number, number> => { for (let k = 0; k < count; k++) m[first + G * k] = 1_000_000; return m; };
/**
 * Sol's reproduction: in the bin [81,020, 81,040) a venue adds $2M at 81,021 and takes $500k off the $1.5M at 81,031 (`next`); the mid is 81,060. With
 * `asks`, the ask at 81,081 doubles too. With `far`, the same pattern is in the bin [80,640, 80,660), twenty-one grid steps from the mid. With `more`, the
 * $2M at 81,021 is $3M (the next publication, `ts`).
 */
const sol = (next: boolean, o: { step?: number | null; asks?: boolean; far?: boolean; more?: boolean; ts?: number } = {}): CueBook => {
  const bids = fillBids(80_990, 60, { 81_059: 1_000_000, 81_045: 1_000_000, 81_031: next ? 1_000_000 : 1_500_000, 81_010: 1_000_000 });
  if (next) bids[81_021] = o.more ? 3_000_000 : 2_000_000;
  if (o.far) { bids[80_653] = next ? 1_000_000 : 1_500_000; if (next) bids[80_641] = 2_000_000; }       // two buckets of two dollars out there (one with the ladder's own 80,650 would merge)
  const asks = fillAsks(81_061, 60);
  if (next && o.asks) asks[81_081] = 2_000_000;
  return venue(o.ts ?? (next ? 2_000 : 1_000), bids, asks, o);
};
/** The same book with its levels in another order: `rising` or `falling` in price on both sides, or `shuffled` (a fixed shuffle). */
const reorder = (b: CueBook, how: 'rising' | 'falling' | 'shuffled'): CueBook => {
  const re = (s: SideArrays): SideArrays => {
    const idx = [...s.usd.keys()];
    if (how === 'rising') idx.sort((x, y) => s.lo[x]! - s.lo[y]!);
    else if (how === 'falling') idx.sort((x, y) => s.lo[y]! - s.lo[x]!);
    else idx.sort((x, y) => ((x * 7919) % 101) - ((y * 7919) % 101));
    const lo = Float64Array.from(idx, i => s.lo[i]!);
    return { lo, hi: lo, usd: Float64Array.from(idx, i => s.usd[i]!) };
  };
  return { ...b, bids: re(b.bids), asks: re(b.asks) };
};
const pairsOf = (flat: readonly number[]): string[] => { const out: string[] = []; for (let j = 0; j + 1 < flat.length; j += 2) out.push(`${flat[j]}:${flat[j + 1]}`); return out.sort(); };

test('a cell keeps the levels it is made of, and a row takes the change its own levels made: +$2M and -$500k in one bin are two rows, not $750k on both', () => {
  const tr = new BookCueTracker();
  tr.observe([sol(false)], [ID], ctx(1_000));
  const e = only(tr.observe([sol(true)], [ID], ctx(2_000)));
  assert.deepEqual([e.side, e.lo, e.hi, e.usd], ['bid', 81_020, 81_040, 1_500_000]);
  assert.deepEqual(e.lv, { prev: [81_031, 1_500_000], cur: [81_031, 1_000_000, 81_021, 2_000_000] });
  assert.deepEqual(rowsOf([e], 10), [[8_102, 2_000_000], [8_103, -500_000]]);
  assert.deepEqual(rowsOf([e], 5), [[16_204, 2_000_000], [16_206, -500_000]], 'no row for the one that holds no level');
  assert.deepEqual(rowsOf([e], 25), [[3_240, 2_000_000], [3_241, -500_000]], '81,025 divides them');
  assert.deepEqual(rowsOf([e], 20), [[4_051, 1_500_000]]);
  assert.deepEqual(rowsOf([e], 50), [[1_620, 1_500_000]], 'one row holds both');
  assert.deepEqual(rowsOf([{ ...e, lv: undefined }], 10), [[8_102, 750_000], [8_103, 750_000]], 'the share by overlap that it replaces');
  const rows = rowEvents([e], 10, 1_000_000);
  assert.deepEqual(rows.map(r => [r.added, r.removed]), [[true, false], [false, false]]);
  near(rows[0]!.strength, 1 - Math.exp(-2)); near(rows[1]!.strength, 1 - Math.exp(-0.5));
  // The hover reads the same events through the same function.
  assert.deepEqual(rowsOf(tr.recentEvents(ID, 'bid', 81_030, 81_040), 10), [[8_102, 2_000_000], [8_103, -500_000]]);
});

interface Glue { default(options: { module_or_path: Uint8Array }): Promise<unknown>; spread_levels: (lo: Float64Array, hi: Float64Array, usd: Float64Array, inst: Uint32Array, nInst: number, step: number, bin0: number, nBins: number) => Float32Array }
/** The repository root, from the source tree or from the compiled tests. */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, 'src', 'app', 'wasm', 'hlm_kernels.js'))) return dir;
  throw new Error('the repository root is not above the tests');
}
/** The committed kernel exactly as shipped (as tests/app-levels-memo.test.mts loads it): what draws the ladder's bars. */
async function spreadKernel(): Promise<Glue['spread_levels']> {
  const root = repoRoot(), glue = await import(pathToFileURL(path.join(root, 'src', 'app', 'wasm', 'hlm_kernels.js')).href) as Glue;
  await glue.default({ module_or_path: fs.readFileSync(path.join(root, 'src', 'app', 'wasm', 'hlm_kernels_bg.wasm')) });
  return glue.spread_levels;
}
/** The rows whose bar changed from one publication of a side to the next on rows of `step`, as the ladder draws them: [row, change in USD]. */
const barChange = (spread: Glue['spread_levels'], a: SideArrays, b: SideArrays, step: number, p0: number, p1: number): [number, number][] => {
  const bin0 = Math.floor(p0 / step), nBins = Math.ceil(p1 / step) - bin0 + 1;
  const bar = (s: SideArrays): Float32Array => spread(s.lo, s.hi, s.usd, new Uint32Array(s.usd.length), 1, step, bin0, nBins);
  const x = bar(a), y = bar(b), out: [number, number][] = [];
  for (let i = 0; i < nBins; i++) if (y[i]! !== x[i]!) out.push([bin0 + i, y[i]! - x[i]!]);
  return out;
};

test('the rows an event is put on are the rows the ladder\'s bars changed on: Sol\'s reproduction against the committed kernel, on every row step', async () => {
  const spread = await spreadKernel(), p0 = sol(false), p1 = sol(true);
  const tr = new BookCueTracker();
  tr.observe([p0], [ID], ctx(1_000));
  const e = only(tr.observe([p1], [ID], ctx(2_000)));
  for (const step of [1, 5, 10, 20, 25, 50, 100]) assert.deepEqual(rowsOf([e], step), barChange(spread, p0.bids, p1.bids, step, 79_000, 82_000), `rows of $${step}`);
});

test('a bin that a row edge cuts is put on its two rows by its levels: the default $50 rows over a $20 grid', () => {
  // Bids on every grid bin, and in the bin [81,040, 81,060), which the $50 edge at 81,050 cuts, $1M at 81,045 and at 81,055: then $500k off the one and $2M on the other.
  const at = (ts: number, a: number, b: number): CueBook => venue(ts, { ...fillBids(81_025, 50), 81_045: a, 81_055: b, 81_069: 1_000_000 }, fillAsks(81_071, 50));
  const tr = new BookCueTracker();
  tr.observe([at(1_000, 1_000_000, 1_000_000)], [ID], ctx(1_000));
  const e = only(tr.observe([at(2_000, 500_000, 3_000_000)], [ID], ctx(2_000)));
  assert.deepEqual([e.lo, e.hi, e.usd], [81_040, 81_060, 1_500_000]);
  assert.deepEqual(rowsOf([e], 50), [[1_620, -500_000], [1_621, 2_000_000]]);
  assert.deepEqual(rowsOf([{ ...e, lv: undefined }], 50), [[1_620, 750_000], [1_621, 750_000]], 'shared by overlap it flashed the wrong way on the first row');
  assert.deepEqual(rowsOf([e], 20), [[4_052, 1_500_000]]);
});

test('a row coarser than the grid sums the changes of its bins, each put by its levels', () => {
  // $100 rows over bins of $20: the row [81,000, 81,100) holds five bins and three of them change (+$1M, -$500k, +$700k).
  const at = (next: boolean): CueBook => venue(next ? 2_000 : 1_000, { ...fillBids(80_985, 60), 81_119: 1_000_000, 81_031: next ? 2_000_000 : 1_000_000, 81_051: next ? 500_000 : 1_000_000, 81_079: next ? 1_700_000 : 1_000_000 }, fillAsks(81_121, 60));
  const tr = new BookCueTracker();
  tr.observe([at(false)], [ID], ctx(1_000));
  const events = tr.observe([at(true)], [ID], ctx(2_000));
  assert.deepEqual(events.map(e => [e.lo, e.usd]), [[81_020, 1_000_000], [81_040, -500_000], [81_060, 700_000]]);
  assert.deepEqual(rowsOf(events, 100), [[810, 1_200_000]]);
  const row = rowEvents(events, 100, 1_000_000)[0]!;
  assert.deepEqual([row.added, row.removed], [false, false]);
  near(row.strength, 1 - Math.exp(-1.2));
  assert.deepEqual(rowsOf(events, 20), [[4_051, 1_000_000], [4_052, -500_000], [4_053, 700_000]]);
});

test('the levels of a cell are found whichever way a venue orders its prices: nearest first, the other way, or not in order at all', () => {
  const events = (how?: 'rising' | 'falling' | 'shuffled'): CueEvent[] => {
    const tr = new BookCueTracker(), put = (b: CueBook): CueBook => how ? reorder(b, how) : b;
    tr.observe([put(sol(false, { asks: true }))], [ID], ctx(1_000));
    return tr.observe([put(sol(true, { asks: true }))], [ID], ctx(2_000));
  };
  const natural = events();
  assert.deepEqual(natural.map(e => [e.side, e.lo, e.usd]), [['bid', 81_020, 1_500_000], ['ask', 81_080, 1_000_000]]);
  assert.deepEqual(rowsOf(natural, 10), [[8_102, 2_000_000], [8_103, -500_000], [8_108, 1_000_000]]);
  for (const how of ['rising', 'falling', 'shuffled'] as const) {
    const got = events(how);
    assert.deepEqual(got.map(e => [e.side, e.lo, e.usd]), [['bid', 81_020, 1_500_000], ['ask', 81_080, 1_000_000]], how);
    got.forEach((e, k) => assert.deepEqual([pairsOf(e.lv!.prev), pairsOf(e.lv!.cur)], [pairsOf(natural[k]!.lv!.prev), pairsOf(natural[k]!.lv!.cur)], `${how} ${e.side}`));
    assert.deepEqual(rowsOf(got, 10), rowsOf(natural, 10), how);
  }
});

test('a level on a bin edge is in the bin it opens, not the one it closes, however the venue orders its prices', () => {
  // Bids at 81,020 and 81,040 exactly: the first opens the bin [81,020, 81,040), the second the bin above it. And one a hair under 81,040 (a part in
  // 10^13), which `binOf` forgives as it forgives a division that comes out a hair under a whole number: it is in the bin above, though its price is below the edge.
  const hair = 81_040 - 1e-8;
  const at = (ts: number, a: number, b: number, c: number): CueBook => venue(ts, { ...fillBids(81_005, 50), 81_020: a, 81_040: b, [hair]: c, 81_069: 1_000_000 }, fillAsks(81_071, 50));
  for (const how of [undefined, 'rising', 'shuffled'] as const) {
    const put = (b: CueBook): CueBook => how ? reorder(b, how) : b, tr = new BookCueTracker();
    tr.observe([put(at(1_000, 1_000_000, 1_000_000, 1_000_000))], [ID], ctx(1_000));
    const events = tr.observe([put(at(2_000, 3_000_000, 2_000_000, 1_500_000))], [ID], ctx(2_000));
    assert.deepEqual(events.map(e => [e.lo, e.usd, pairsOf(e.lv!.prev), pairsOf(e.lv!.cur)]), [
      [81_020, 2_000_000, ['81020:1000000'], ['81020:3000000']],
      [81_040, 1_500_000, [`${hair}:1000000`, '81040:1000000'].sort(), [`${hair}:1500000`, '81040:2000000'].sort()],
    ], String(how));
  }
});

test('a book whose grid is not published keeps the levels of its cells too, and its events say the grid is a guess', () => {
  const tr = new BookCueTracker();
  tr.observe([sol(false, { step: null })], [ID], ctx(1_000));
  const e = only(tr.observe([sol(true, { step: null })], [ID], ctx(2_000)));
  assert.equal(e.approx, true);
  assert.deepEqual(rowsOf([e], 10), [[8_102, 2_000_000], [8_103, -500_000]]);
});

/** A bin [81,020, 81,040) of three levels (81,021, 81,025 and 81,031), $1M each at first, in a ladder with a mean cell of about $1M (a gate of about $52k). */
const weakBook = (ts: number, a: number, b: number): CueBook => venue(ts, { ...fillBids(81_045, 50), 81_021: a, 81_031: b }, fillAsks(81_065, 50));

test('a weak change that is confirmed later is put on the rows by the levels of the publication before it, not of the one between', () => {
  const tr = new BookCueTracker();
  tr.observe([weakBook(1_000, 1_000_000, 1_000_000)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([weakBook(2_000, 1_100_000, 1_000_000)], [ID], ctx(2_000)), [], '+$100k against a gate of about $52k: waiting');
  const e = only(tr.observe([weakBook(3_000, 1_200_000, 950_000)], [ID], ctx(3_000)));
  assert.deepEqual([e.confirmed, e.usd, e.before, e.after, e.prevWall, e.wall], [true, 150_000, 3_000_000, 3_150_000, 1_000, 3_000]);
  assert.deepEqual(e.lv, { prev: [81_031, 1_000_000, 81_025, 1_000_000, 81_021, 1_000_000], cur: [81_031, 950_000, 81_025, 1_000_000, 81_021, 1_200_000] });
  assert.deepEqual(rowsOf([e], 10), [[8_102, 200_000], [8_103, -50_000]], 'from the first publication: the second would have made the first row +$100k');
  // A move the other way is judged from the value before the weak one, and so are its levels.
  const back = new BookCueTracker();
  back.observe([weakBook(1_000, 1_000_000, 1_000_000)], [ID], ctx(1_000));
  back.observe([weakBook(2_000, 1_100_000, 1_000_000)], [ID], ctx(2_000));
  const down = only(back.observe([weakBook(3_000, 500_000, 1_000_000)], [ID], ctx(3_000)));
  assert.deepEqual([down.confirmed, down.usd, down.before, down.prevWall], [false, -500_000, 3_000_000, 1_000]);
  assert.deepEqual(rowsOf([down], 10), [[8_102, -500_000]]);
  // A change that came back is dropped, and what waited with it is gone: the next one starts from its own publication.
  const gone = new BookCueTracker();
  gone.observe([weakBook(1_000, 1_000_000, 1_000_000)], [ID], ctx(1_000));
  gone.observe([weakBook(2_000, 1_100_000, 1_000_000)], [ID], ctx(2_000));
  assert.deepEqual(gone.observe([weakBook(3_000, 1_000_000, 1_000_000)], [ID], ctx(3_000)), []);
  const next = only(gone.observe([weakBook(4_000, 2_000_000, 1_000_000)], [ID], ctx(4_000)));
  assert.deepEqual([next.usd, next.confirmed, next.lv!.prev], [1_000_000, false, [81_031, 1_000_000, 81_025, 1_000_000, 81_021, 1_000_000]]);
});

test('the levels a weak change waits with move with its cell when the window follows the mid, up or down', () => {
  // Up: the best ask is $560 higher, so the mid moves fourteen bins, past the spare cells either side of the window. The bin is then sixteen grid steps
  // from the mid, too far to keep levels with the usual tuning: so one tracker keeps them everywhere, to see them move, and the usual one keeps none.
  const later = (ts: number, a: number, b: number): CueBook => venue(ts, { ...fillBids(81_045, 50), 81_021: a, 81_031: b }, fillAsks(81_065 + 20 * 28, 30));
  const up = (tuning: Partial<CueTuning>): CueEvent | undefined => {
    const tr = new BookCueTracker(tuning);
    tr.observe([weakBook(1_000, 1_000_000, 1_000_000)], [ID], ctx(1_000));
    tr.observe([weakBook(2_000, 1_100_000, 1_000_000)], [ID], ctx(2_000));
    return tr.observe([later(3_000, 1_200_000, 950_000)], [ID], ctx(3_000)).find(x => x.side === 'bid' && x.confirmed);
  };
  const kept = up({ lvSteps: 1e9 });
  assert.ok(kept, 'confirmed in a window that has moved');
  assert.deepEqual(kept.lv!.prev, [81_031, 1_000_000, 81_025, 1_000_000, 81_021, 1_000_000]);
  assert.deepEqual(rowsOf([kept], 10), [[8_102, 200_000], [8_103, -50_000]]);
  const usual = up({});
  assert.ok(usual); assert.equal(usual.lv, undefined, 'a bin that ends up beyond twelve and a half steps of the mid keeps none');
  assert.deepEqual([usual.usd, usual.confirmed], [kept.usd, true]);
  // Down: the mid moves nine bins the other way, past the window's spare cells, and an ask bin stays within twelve and a half steps of it.
  const ask = (ts: number, a: number, b: number, moved: boolean): CueBook => moved
    ? venue(ts, fillBids(80_865, 50), { ...fillAsks(80_885, 100), 81_081: a, 81_091: b })
    : venue(ts, fillBids(81_045, 50), { ...fillAsks(81_065, 50), 81_081: a, 81_091: b });
  const tr = new BookCueTracker();
  tr.observe([ask(1_000, 1_000_000, 1_000_000, false)], [ID], ctx(1_000));
  tr.observe([ask(2_000, 1_100_000, 1_000_000, false)], [ID], ctx(2_000));
  const down = tr.observe([ask(3_000, 1_200_000, 950_000, true)], [ID], ctx(3_000)).find(x => x.side === 'ask' && x.confirmed);
  assert.ok(down, 'confirmed in a window that has moved down');
  assert.deepEqual(down.lv, { prev: [81_081, 1_000_000, 81_085, 1_000_000, 81_091, 1_000_000], cur: [81_081, 1_200_000, 81_085, 1_000_000, 81_091, 950_000] });
  assert.deepEqual(rowsOf([down], 10), [[8_108, 200_000], [8_109, -50_000]]);
});

test('a side that has a band level, now or in the publication before, leaves its events to the share by overlap; the other side keeps its levels', () => {
  const make = (ts: number, k: number, band: boolean): CueBook => {          // $1M a bin, then k $M more at a bid and at an ask; with `band`, the tenth bid is a band of eight dollars inside its bin
    const l = ladder(); l.bids.set(MID - 3, 1_000_000 + k * 1_000_000); l.asks.set(MID + 3, 1_000_000 + k * 1_000_000);
    const b = book(ID, ts, l);
    if (band) { const hi = Float64Array.from(b.bids.lo); hi[9]! += 8; b.bids = { lo: b.bids.lo, hi, usd: b.bids.usd }; }
    return b;
  };
  const has = (events: readonly CueEvent[]): [string, boolean][] => events.map(e => [e.side, e.lv !== undefined]);
  const tr = new BookCueTracker();
  tr.observe([make(1_000, 0, true)], [ID], ctx(1_000));
  const now = tr.observe([make(2_000, 1, true)], [ID], ctx(2_000));
  assert.deepEqual(has(now), [['bid', false], ['ask', true]], 'a band level now');
  assert.deepEqual(has(tr.observe([make(3_000, 2, false)], [ID], ctx(3_000))), [['bid', false], ['ask', true]], 'a band level in the publication before');
  assert.deepEqual(has(tr.observe([make(4_000, 3, false)], [ID], ctx(4_000))), [['bid', true], ['ask', true]], 'none in either');
  assert.deepEqual(rowsOf([now[0]!], 10), [[8_122, 500_000], [8_123, 500_000]], 'the bin shared over its two rows');
  // A band is never given levels, whatever its book.
  const banded = new BookCueTracker();
  banded.observe([tenBands(1_000)], [HL], ctx(1_000));
  assert.equal(only(banded.observe([tenBands(6_400, { bid: run(40, 5, { 60: 4 * MILLION }) })], [HL], ctx(6_400))).lv, undefined);
});

test('a weak change noted in a publication that has a band level keeps the levels of the publication before it, and is put on rows by them when a clean one confirms it', () => {
  // $1M a bin; the bid at MID - 3 as given; with `band`, the tenth bid is a band of eight dollars inside its bin.
  const at = (ts: number, usd: number, band: boolean): CueBook => {
    const l = ladder(); l.bids.set(MID - 3, usd);
    const b = book(ID, ts, l);
    if (band) { const hi = Float64Array.from(b.bids.lo); hi[9]! += 8; b.bids = { lo: b.bids.lo, hi, usd: b.bids.usd }; }
    return b;
  };
  const tr = new BookCueTracker();
  tr.observe([at(1_000, 1_000_000, false)], [ID], ctx(1_000));
  assert.deepEqual(tr.observe([at(2_000, 1_100_000, true)], [ID], ctx(2_000)), [], '+$100k with a band level on the side: weak, and waiting');
  const e = only(tr.observe([at(3_000, 1_200_000, false)], [ID], ctx(3_000)));
  assert.deepEqual([e.confirmed, e.usd, e.before, e.after], [true, 200_000, 1_000_000, 1_200_000]);
  const price = (MID - 3 + 0.5) * G;
  assert.deepEqual(e.lv, { prev: [price, 1_000_000], cur: [price, 1_200_000] });
  // One that is confirmed while the side has a band level is left to the share: the levels of the confirming publication are not prices.
  const shared = new BookCueTracker();
  shared.observe([at(1_000, 1_000_000, false)], [ID], ctx(1_000));
  shared.observe([at(2_000, 1_100_000, false)], [ID], ctx(2_000));
  assert.equal(only(shared.observe([at(3_000, 1_200_000, true)], [ID], ctx(3_000))).lv, undefined);
});

test('rows of an event with levels: a window keeps only its rows, at most 4,096 are made, levels that cancel in a row leave none, and a row\'s own old and new USD say removed and added', () => {
  const lv = (prev: number[], cur: number[]): CueEvent => ev({ lo: 81_020, hi: 81_040, usd: 0, lv: { prev, cur } });
  const moved = lv([81_021, 1_000_000], [81_031, 2_000_000]);                      // a level that moved to the next row, and doubled
  assert.deepEqual(rowEvents([moved], 10, 1_000_000).map(r => [r.row, r.usd, r.removed, r.added]), [[8_102, -1_000_000, true, false], [8_103, 2_000_000, false, true]]);
  // A window keeps its rows and one more either side: the row before the window's, not two before; the row after, not two after.
  assert.deepEqual(rowsOf([moved], 10, { lo: 81_030, hi: 81_039 }), [[8_102, -1_000_000], [8_103, 2_000_000]]);
  assert.deepEqual(rowsOf([moved], 10, { lo: 81_040, hi: 81_049 }), [[8_103, 2_000_000]]);
  assert.deepEqual(rowsOf([moved], 10, { lo: 81_010, hi: 81_019 }), [[8_102, -1_000_000]]);
  assert.deepEqual(rowsOf([moved], 10, { lo: 81_050, hi: 81_059 }), []);
  assert.deepEqual(rowsOf([moved], 10, { lo: 90_000, hi: 91_000 }), []);
  assert.deepEqual(rowsOf([lv([100.5, 0.1, 100.7, 0.2], [100.6, 0.3])], 1), [], 'levels that cancel to float dust leave no row');
  const many = lv([], Array.from({ length: 5_000 }, (_, i) => [200_000 + i, 1]).flat());
  const capped = rowEvents([many], 1, 1_000_000);
  assert.equal(capped.length, 4_096); assert.equal(capped[0]!.row, 200_000);
  assert.equal(rowEvents([many], 1, 1_000_000, { lo: 200_000, hi: 200_099 }).length, 101, 'the cap is after the window: its hundred rows and the one after (the one before holds no level)');
  assert.deepEqual(rowsOf([lv([81_021, 1_000_000, 5], [81_031, Number.NaN, 81_035, -3, 0, 4])], 10), [[8_102, -1_000_000]], 'a stray element, NaN and non-positive figures are passed over');
  // An event with levels and one without meet in a row: summed.
  assert.deepEqual(rowsOf([moved, ev({ lo: 81_030, hi: 81_050, usd: 400_000 })], 10), [[8_102, -1_000_000], [8_103, 2_200_000], [8_104, 200_000]]);
  // A level is in the row the kernel puts it in, the floor of price / step as it comes out: 0.3 / 0.1 is 2.9999999999999996, so row 2 (`binOf` would say 3).
  assert.deepEqual(rowsOf([lv([], [0.3, 1_000])], 0.1), [[2, 1_000]]);
});

test('over random merged books, with levels kept everywhere, an event\'s rows on any row step add up to its bin\'s change and are what accumulating its bin\'s levels on that step gives (the pure twin of the kernel)', () => {
  const rnd = rng(21);
  let events = 0, rowsChecked = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n0 = nativeBook(rnd, 812_000 + Math.floor(rnd() * 8_000)), n1 = mutate(rnd, n0), p0 = published(n0), p1 = published(n1);
    const tr = new BookCueTracker({ ...open, lvSteps: 1e9 });
    tr.observe([pubBook(ID, 1_000, p0)], [ID], tiny(1_000));
    const raised = tr.observe([pubBook(ID, 2_000, p1)], [ID], tiny(2_000));
    for (const e of raised) {
      assert.ok(e.lv, `trial ${trial}: a point book lists the levels of its cells`);
      events++;
      for (const step of [5, 7, 10, 25, 50, 100]) near(rowEvents([e], step, 1e6).reduce((s, r) => s + r.usd, 0) / Math.max(1, Math.abs(e.usd)), e.usd / Math.max(1, Math.abs(e.usd)), `trial ${trial} $${step}`);
    }
    for (const side of ['bid', 'ask'] as const) {
      const bins = new Set(raised.filter(e => e.side === side).map(e => Math.round(e.lo / G)));
      const pick = (s: SideArrays): SideArrays => { const keep = [...s.usd.keys()].filter(i => bins.has(binOf(s.lo[i]!, G))); return { lo: Float64Array.from(keep, i => s.lo[i]!), hi: Float64Array.from(keep, i => s.hi[i]!), usd: Float64Array.from(keep, i => s.usd[i]!) }; };
      for (const step of [5, 10, 25, 50, 100]) {
        const m0 = new Map<number, number>(), m1 = new Map<number, number>(), expected = new Map<number, number>();
        accumulateSide(pick(side === 'bid' ? p0.bids : p0.asks), step, m0); accumulateSide(pick(side === 'bid' ? p1.bids : p1.asks), step, m1);
        for (const r of new Set([...m0.keys(), ...m1.keys()])) { const d = (m1.get(r) ?? 0) - (m0.get(r) ?? 0); if (d !== 0) expected.set(r, d); }
        const got = new Map(rowsOf(raised.filter(e => e.side === side), step));
        assert.deepEqual([...got].sort((x, y) => x[0] - y[0]), [...expected].sort((x, y) => x[0] - y[0]), `trial ${trial} ${side} $${step}`);
        rowsChecked += expected.size;
      }
    }
  }
  assert.ok(events > 300 && rowsChecked > 2_000, `${events} events, ${rowsChecked} rows`);
});

test('over random merged books, exactly the events of bins wholly within twelve and a half steps of the mid, in both publications, keep their levels; the rest are shared by overlap', () => {
  const rnd = rng(23);
  const midOf = (p: { bids: SideArrays; asks: SideArrays }): number => (highest(p.bids.hi) + lowest(p.asks.lo)) / 2 / G;     // in grid steps, as the tracker takes it
  const within = (bin: number, m: number): boolean => bin >= m - 12.5 && bin <= m + 12.5 - 1;
  let kept = 0, shared = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n0 = nativeBook(rnd, 812_000 + Math.floor(rnd() * 8_000)), n1 = mutate(rnd, n0), p0 = published(n0), p1 = published(n1);
    const tr = new BookCueTracker(open);
    tr.observe([pubBook(ID, 1_000, p0)], [ID], tiny(1_000));
    const raised = tr.observe([pubBook(ID, 2_000, p1)], [ID], tiny(2_000));
    const m0 = midOf(p0), m1 = midOf(p1);
    for (const e of raised) {
      const bin = Math.round(e.lo / G), expected = within(bin, m0) && within(bin, m1);
      assert.equal(e.lv !== undefined, expected, `trial ${trial} bin ${bin} (mids ${m0}, ${m1})`);
      if (expected) kept++; else shared++;
      for (const step of [5, 25, 50]) near(rowEvents([e], step, 1e6).reduce((sum, r) => sum + r.usd, 0) / Math.max(1, Math.abs(e.usd)), e.usd / Math.max(1, Math.abs(e.usd)), `trial ${trial} $${step}`);
    }
  }
  assert.ok(kept > 50 && shared > 50, `${kept} events keep their levels, ${shared} do not`);
});

// ---- Ghost keys, and a venue that left the frame ----

test('a band regrouped beside a ghost is still a regrouping: a ghost is no band the previous publication held (Sol\'s three steps)', () => {
  const tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  // 1. [60, 70) goes, and leaves a ghost.
  const gone = only(tr.observe([tenBands(2_000, { bid: run(40, 5, { 60: null }) })], [HL], ctx(2_000)));
  assert.deepEqual([gone.lo, gone.removed, gone.usd, gone.lv], [60, true, -MILLION, undefined]);
  // 2. [70, 80) is regrouped as [60, 80).
  const joined: Band[] = [...run(40, 2), [60, 80, MILLION], [80, 90, MILLION]];
  assert.deepEqual(tr.observe([tenBands(3_000, { bid: joined })], [HL], ctx(3_000)), []);
  // 3. That band splits into [60, 70) and [70, 80) of $500k: the ghost of [60, 70) is held, and is not the band that was there.
  const split: Band[] = [...run(40, 2), [60, 70, 500_000], [70, 80, 500_000], [80, 90, MILLION]];
  assert.deepEqual(tr.observe([tenBands(4_000, { bid: split })], [HL], ctx(4_000)), []);
  assert.equal(tr.stats.baselines, 1);
  for (const [lo, hi] of [[60, 70], [70, 80]] as const) assert.deepEqual(tr.heat(HL, 'bid', lo, hi, 4_000), { fresh: 0, unknown: 1, activity: 0 });
  assert.equal(tr.recent(HL, 'bid', 60, 70)?.removed, true, 'what the ghost last showed stays with its edges, for the hover');
  // The bands go on being compared from there.
  assert.equal(only(tr.observe([tenBands(5_000, { bid: [...run(40, 2), [60, 70, 500_000], [70, 80, 3 * MILLION], [80, 90, MILLION]] })], [HL], ctx(5_000))).lo, 70);
});

test('a band that went empty and comes back with nothing regrouped is still an addition, beside a regrouping elsewhere too', () => {
  const tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  tr.observe([tenBands(2_000, { bid: run(40, 5, { 60: null }) })], [HL], ctx(2_000));                    // [60, 70) goes: a ghost
  assert.deepEqual(only(tr.observe([tenBands(3_000)], [HL], ctx(3_000))).added, true, 'it returns as it was');
  const again = new BookCueTracker();
  again.observe([tenBands(1_000)], [HL], ctx(1_000));
  again.observe([tenBands(2_000, { bid: run(40, 5, { 60: null }) })], [HL], ctx(2_000));
  const back: Band[] = [...run(40, 4), [80, 85, 500_000], [85, 90, 500_000]];                              // it returns while [80, 90) is regrouped
  assert.deepEqual(again.observe([tenBands(3_000, { bid: back })], [HL], ctx(3_000)).map(e => [e.lo, e.added, e.usd]), [[60, true, MILLION]]);
});

test('a venue that vanishes from the frame starts again when it is back, with ids made from the frame as the pane makes them; a book that is in the frame and out of ids is left alone', () => {
  const l = ladder(), big = copy(l); big.asks.set(MID + 4, 3_000_000);
  const bigger = copy(big); bigger.asks.set(MID + 4, 5_000_000);
  const idsOf = (frame: CueBook[]): string[] => frame.map(b => b.id);                                      // `activeIds`: the books of the frame
  const tr = new BookCueTracker(), a0 = book('a', 1_000, l), b0 = book('b', 1_000, l);
  tr.observe([a0, b0], idsOf([a0, b0]), ctx(1_000));
  tr.observe([b0], idsOf([b0]), ctx(1_250));                                                               // a is gone from the frame, and from the ids with it
  assert.equal(tr.info('a')!.usable, false);
  assert.equal(tr.heat('a', 'ask', ...cell(MID + 4), 1_250), null);
  const a1 = book('a', 2_000, big);
  assert.deepEqual(tr.observe([a1, b0], idsOf([a1, b0]), ctx(2_000)), [], 'its replacement is a baseline, whatever it shows');
  assert.equal(tr.stats.baselines, 3);
  const a2 = book('a', 3_000, bigger);
  assert.equal(only(tr.observe([a2, b0], idsOf([a2, b0]), ctx(3_000))).usd, 2_000_000, 'and is compared from then on');
  // A book that is in the frame and out of the ids (the reader hid it) is kept as it was, and compared when it is asked for again.
  const hid = new BookCueTracker(), a = book('a', 1_000, l);
  hid.observe([a, b0], ['a', 'b'], ctx(1_000));
  hid.observe([a, b0], ['b'], ctx(1_250));
  assert.equal(hid.info('a')!.usable, true);
  assert.equal(only(hid.observe([book('a', 2_000, big), b0], ['a', 'b'], ctx(2_000))).usd, 2_000_000);
  assert.equal(hid.stats.baselines, 2);
  // An empty frame takes every book out of it, once; a repeated book is not one that left.
  const gap = new BookCueTracker();
  gap.observe([a, b0], idsOf([a, b0]), ctx(1_000)); gap.observe([a, b0], idsOf([a, b0]), ctx(1_250));
  assert.equal(gap.info('a')!.usable, true);
  gap.observe([], [], ctx(1_500));
  assert.deepEqual([gap.info('a')!.usable, gap.info('b')!.usable], [false, false]);
  gap.observe([], [], ctx(1_750));
  assert.deepEqual(gap.observe([book('a', 2_000, big), b0], idsOf([a, b0]), ctx(2_000)), []);
  assert.equal(gap.stats.baselines, 4);
});

// ---- Where levels are kept: near the mid, where the merge's buckets are at their finest ----

test('the limit is where the merge stops keeping its finest bucket: pinned against bucketWidth, so a change in shared/merge.ts fails here', () => {
  assert.equal(LV_STEPS, 12.5);
  assert.equal(DEFAULT_TUNING.lvSteps, LV_STEPS);
  assert.equal(LV_STEPS, 1 / MERGE_FINEST / MERGE_DISTANCE_SHARE);
  for (const step of [0.5, 1, 20, 25, 100]) {
    const finest: number = bucketWidth(0, step), limit: number = LV_STEPS * step;
    assert.equal(finest, step / MERGE_FINEST, `the finest bucket is a twentieth of the step ($${step})`);
    assert.equal(bucketWidth(limit * (1 - 1e-9), step), finest, `still the finest just inside the limit ($${step})`);
    assert.ok(bucketWidth(limit * (1 + 1e-9), step) > finest, `wider just past it ($${step})`);
  }
});

test('a bin within twelve and a half steps of the mid keeps its levels and its rows follow them; the same pattern farther out is shared by overlap', () => {
  const tr = new BookCueTracker();
  tr.observe([sol(false, { far: true })], [ID], ctx(1_000));
  const events = tr.observe([sol(true, { far: true })], [ID], ctx(2_000));
  assert.deepEqual(events.map(e => [e.lo, e.usd, e.lv !== undefined]), [[80_640, 1_500_000, false], [81_020, 1_500_000, true]]);
  const [far, near2] = events as [CueEvent, CueEvent];
  assert.deepEqual(rowsOf([near2], 10), [[8_102, 2_000_000], [8_103, -500_000]], 'two steps out: Sol\'s rows');
  assert.deepEqual(rowsOf([near2], 50), [[1_620, 1_500_000]]);
  assert.deepEqual(rowsOf([far], 10), [[8_064, 750_000], [8_065, 750_000]], 'twenty-one steps out: the share by overlap');
});

test('a $60k cancellation in a $5M bucket that hops across a row edge is a mild $60k beyond the limit, where levels would read -$5M and +$4.94M', () => {
  // Out at 80,150 the merge's buckets are four dollars wide: 80,149 and 80,151 are one bucket of $5M, reported at the lower (the farthest bid), in row 8014 of $10.
  // When the $60k at 80,149 goes the bucket is reported at 80,151, in row 8015: the bar moves $5M up a row for a $60k change.
  const at = (ts: number, gone: boolean): CueBook => {
    const bids = fillBids(81_059, 80, { 80_151: 4_940_000 });
    if (!gone) bids[80_149] = 60_000;
    return venue(ts, bids, fillAsks(81_061, 80));
  };
  const run = (tuning: Partial<CueTuning>): CueEvent => {
    const tr = new BookCueTracker({ confirmRatio: 0, ...tuning });
    tr.observe([at(1_000, false)], [ID], ctx(1_000));
    return only(tr.observe([at(2_000, true)], [ID], ctx(2_000)));
  };
  const e = run({});
  assert.deepEqual([e.lo, e.hi, e.usd, e.before, e.after], [80_140, 80_160, -60_000, 6_000_000, 5_940_000]);
  assert.equal(e.lv, undefined);
  assert.deepEqual(rowsOf([e], 10), [[8_014, -30_000], [8_015, -30_000]], 'a share of the $60k: never the wrong way by more than the change');
  assert.ok(Math.max(...rowEvents([e], 10, 1_000_000).map(r => r.strength)) < 0.05, 'a mild cue');
  const hop = run({ lvSteps: 1e9 });
  assert.deepEqual(rowsOf([hop], 10), [[8_014, -5_000_000], [8_015, 4_940_000]], 'the bar hops, and levels would hop with it');
  assert.ok(Math.min(...rowEvents([hop], 10, 1_000_000).map(r => r.strength)) > 0.99, 'two cues at full strength for a $60k change');
});

test('the limit is in grid steps: a bin a hundred and forty dollars out is near on a $20 grid and far on a $10 one', () => {
  // Bids every $10 and the asks above them; the levels at 80,969 and 80,929 double: the bins holding them lie 100 and 140 from the mid (81,060).
  const at = (ts: number, step: number, next: boolean): CueBook => {
    const bids: Record<number, number> = {}, asks: Record<number, number> = {};
    for (let k = 0; k < 80; k++) { bids[81_059 - 10 * k] = 1_000_000; asks[81_061 + 10 * k] = 1_000_000; }
    if (next) { bids[80_969] = 2_000_000; bids[80_929] = 2_000_000; }
    return venue(ts, bids, asks, { step });
  };
  const run = (step: number): [number, boolean][] => {
    const tr = new BookCueTracker();
    tr.observe([at(1_000, step, false)], [ID], ctx(1_000));
    return tr.observe([at(2_000, step, true)], [ID], ctx(2_000)).map(e => [e.lo, e.lv !== undefined]);
  };
  assert.deepEqual(run(10), [[80_920, false], [80_960, true]], '$10 grid: 14 steps out is far, 10 is near (about $125)');
  assert.deepEqual(run(20), [[80_920, true], [80_960, true]], '$20 grid: 7 and 5 steps out are both near (about $250)');
});

test('the edge of the zone is a bin\'s far edge in both publications: twelve steps is in and thirteen is out, on both sides, whether the mid stays or moves a bin either way', () => {
  // The mid is 81,060 (4,053 bins of $20). In the second publication the levels in the bid bins 4,040 to 4,042 and the ask bins 4,063 to 4,065 double, and the
  // mid stays, moves down a bin (the two top bids go: 81,040) or up one (the two top asks go: 81,080). The bin must be near the mid of both publications.
  const at = (ts: number, next: boolean, move: 'stay' | 'down' | 'up'): CueBook => {
    const gone = next ? move : 'stay';
    const bids = gone === 'down' ? fillBids(81_019, 88) : fillBids(81_059, 90), asks = gone === 'up' ? fillAsks(81_101, 88) : fillAsks(81_061, 90);
    if (next) for (const price of [80_819, 80_839, 80_859]) bids[price] = 2_000_000;
    if (next) for (const price of [81_261, 81_281, 81_301]) asks[price] = 2_000_000;
    return venue(ts, bids, asks);
  };
  const kept = (move: 'stay' | 'down' | 'up'): string[] => {
    const tr = new BookCueTracker();
    tr.observe([at(1_000, false, move)], [ID], ctx(1_000));
    return tr.observe([at(2_000, true, move)], [ID], ctx(2_000)).filter(e => e.usd === 1_000_000).map(e => `${e.side} ${e.lo / G}${e.lv !== undefined ? ' kept' : ' shared'}`);
  };
  assert.deepEqual(kept('stay'), ['bid 4040 shared', 'bid 4041 kept', 'bid 4042 kept', 'ask 4063 kept', 'ask 4064 kept', 'ask 4065 shared']);
  assert.deepEqual(kept('down'), ['bid 4040 shared', 'bid 4041 kept', 'bid 4042 kept', 'ask 4063 kept', 'ask 4064 shared', 'ask 4065 shared'], 'the new mid is nearer the bids: its upper bound takes the ask bin 4064 out, and the old one\'s lower bound still keeps the bid bin 4040 out');
  assert.deepEqual(kept('up'), ['bid 4040 shared', 'bid 4041 shared', 'bid 4042 kept', 'ask 4063 kept', 'ask 4064 kept', 'ask 4065 shared'], 'the new mid is nearer the asks: its lower bound takes the bid bin 4041 out, and the old one\'s upper bound still keeps the ask bin 4065 out');
});

test('lvSteps 0 keeps no levels, and a weak change keeps none to confirm with', () => {
  const tr = new BookCueTracker({ lvSteps: 0 });
  tr.observe([sol(false)], [ID], ctx(1_000));
  const e = only(tr.observe([sol(true)], [ID], ctx(2_000)));
  assert.equal(e.lv, undefined);
  assert.deepEqual(rowsOf([e], 10), [[8_102, 750_000], [8_103, 750_000]]);
  const weak = new BookCueTracker({ lvSteps: 0 });
  weak.observe([weakBook(1_000, 1_000_000, 1_000_000)], [ID], ctx(1_000));
  weak.observe([weakBook(2_000, 1_100_000, 1_000_000)], [ID], ctx(2_000));
  const confirmed = only(weak.observe([weakBook(3_000, 1_200_000, 950_000)], [ID], ctx(3_000)));
  assert.deepEqual([confirmed.confirmed, confirmed.lv], [true, undefined]);
});

test('a bin keeps its levels only if it was near the mid in the publication that holds them: the one before counts for a change measured from it', () => {
  // The mid is 81,060 and the bin of 80,819 is thirteen steps from it. Then the two top bids go: the mid is 81,040 and that bin is twelve steps from it.
  const at = (ts: number, level: number, topGone: boolean, price: number): CueBook => {
    const bids = topGone ? fillBids(81_019, 88) : fillBids(81_059, 90);
    bids[price] = level;
    return venue(ts, bids, fillAsks(81_061, 90));
  };
  const binLo = (price: number): number => Math.floor(price / G) * G;
  // A change measured from a publication whose mid was far from the bin: no levels, though the bin is near the mid now.
  const first = new BookCueTracker();
  first.observe([at(1_000, 1_000_000, false, 80_819)], [ID], ctx(1_000));
  const far = first.observe([at(2_000, 2_000_000, true, 80_819)], [ID], ctx(2_000)).find(e => e.side === 'bid' && e.lo === binLo(80_819));
  assert.ok(far); assert.equal(far.lv, undefined, 'the levels of a merge that far from its mid are not exact');
  // The same bin measured from a publication whose mid is already the new one: levels.
  const second = new BookCueTracker();
  second.observe([at(1_000, 1_000_000, false, 80_819)], [ID], ctx(1_000));
  second.observe([at(2_000, 2_000_000, true, 80_819)], [ID], ctx(2_000));
  const near2 = second.observe([at(3_000, 3_000_000, true, 80_819)], [ID], ctx(3_000)).find(e => e.lo === binLo(80_819));
  assert.ok(near2); assert.deepEqual(near2.lv, { prev: [80_819, 2_000_000], cur: [80_819, 3_000_000] });
  // A weak change noted while its bin is far keeps no levels, though the bin is near when it is confirmed; one noted near keeps them.
  const weak = (price: number): CueEvent | undefined => {
    const t = new BookCueTracker();
    t.observe([at(1_000, 1_000_000, false, price)], [ID], ctx(1_000));
    assert.deepEqual(t.observe([at(2_000, 1_100_000, false, price)], [ID], ctx(2_000)), [], '+$100k: weak, waiting');
    return t.observe([at(3_000, 1_200_000, true, price)], [ID], ctx(3_000)).find(e => e.confirmed && e.lo === binLo(price));
  };
  const farThen = weak(80_819), nearThen = weak(80_839);
  assert.ok(farThen); assert.equal(farThen.lv, undefined);
  assert.ok(nearThen); assert.deepEqual(nearThen.lv, { prev: [80_839, 1_000_000], cur: [80_839, 1_200_000] });
});

// ---- One row by its own index (Sol's round C) ----

test('a decimal step puts a level in the row the kernel puts it in, and rowEventAt reads that row by its index, not by a price', () => {
  // 65,536.2 / 0.1 is 655,361.9999999999, 65,536.25 / 0.1 is 655,362.5 and 65,536.3 / 0.1 is 655,363: the floor puts the three levels in rows 655,361,
  // 655,362 and 655,363 (`binOf`, which forgives the hair, would put the first in 655,362: the row of the price's neighbour).
  const at = (...levels: [number, number][]): CueEvent => ev({ lo: 65_536, hi: 65_537, usd: levels.reduce((sum, l) => sum + l[1], 0), lv: { prev: [], cur: levels.flat() } });
  const all = at([65_536.2, 100_000], [65_536.25, 200_000], [65_536.3, 300_000]);
  assert.deepEqual(rowsOf([all], 0.1), [[655_361, 100_000], [655_362, 200_000], [655_363, 300_000]]);
  for (const [row, usd] of [[655_361, 100_000], [655_362, 200_000], [655_363, 300_000]] as const) {
    const r = rowEventAt([all], row, 0.1, 1_000_000);
    assert.ok(r, `row ${row}`); assert.deepEqual([r.row, r.usd], [row, usd]);
  }
  assert.equal(rowEventAt([all], 655_360, 0.1, 1_000_000), null);
  assert.equal(rowEventAt([all], 655_364, 0.1, 1_000_000), null);
  // Each alone, the middle one with a neighbour's price for a window: the window's row by the floor is 655,361, and the level's is the next, which the margin keeps.
  const middle = at([65_536.25, 200_000]);
  assert.deepEqual(rowsOf([middle], 0.1, { lo: 65_536.2, hi: 65_536.2 }), [[655_362, 200_000]]);
  assert.deepEqual(rowsOf([middle], 0.1, { lo: 65_536.3, hi: 65_536.3 }), [[655_362, 200_000]]);
  assert.deepEqual(rowsOf([middle], 0.1, { lo: 65_536.5, hi: 65_536.5 }), [], 'two rows above the window\'s is out');
  assert.deepEqual(rowsOf([middle], 0.1, { lo: 65_536, hi: 65_536 }), [], 'and two rows below');
  // An event without levels shares its USD by its overlap with the row, from the row's index alone.
  const share = ev({ lo: 65_536, hi: 65_537, usd: 1_000_000 });
  for (const row of [655_360, 655_362, 655_369]) assert.ok(Math.abs(rowEventAt([share], row, 0.1, 1_000_000)!.usd - 100_000) < 0.01, `row ${row}: a tenth of the $1M, to the dust of prices near 65,536`);
  assert.equal(rowEventAt([share], 655_359, 0.1, 1_000_000), null);
  assert.equal(rowEventAt([share], 655_370, 0.1, 1_000_000), null);
});

test('rowEventAt is the row rowEvents gives for the same events, at every step, for events with levels, without them, bands, and another publication\'s', () => {
  const events: CueEvent[] = [
    ev({ lo: 81_020, hi: 81_040, usd: 1_500_000, seq: 1, lv: { prev: [81_031, 1_500_000], cur: [81_031, 1_000_000, 81_021, 2_000_000] } }),
    ev({ lo: 81_040, hi: 81_060, usd: -400_000, seq: 2 }),
    ev({ lo: 81_060, hi: 81_100, grid: 0, usd: 2_000_000, seq: 3, band: true }),
    ev({ lo: 81_100, hi: 81_120, usd: 300_000, seq: 4, lv: { prev: [81_105.5, 100_000], cur: [81_105.5, 200_000, 81_119.9, 200_000] } }),
    ev({ lo: 81_020, hi: 81_040, usd: 10_000, seq: 5, wall: 2_000 }),
  ];
  for (const step of [0.1, 0.5, 1, 5, 10, 25, 50]) {
    const all = rowEvents(events, step, 1_000_000);
    let seen = 0;
    for (let row = Math.floor(81_000 / step); row <= Math.floor(81_200 / step); row++) {
      const got = rowEventAt(events, row, step, 1_000_000);
      assert.deepEqual(got, all.find(r => r.row === row) ?? null, `$${step} row ${row}`);
      if (got) seen++;
    }
    assert.equal(seen, new Set(all.map(r => r.row)).size, `$${step}: every row rowEvents makes is found, none else`);
  }
  assert.equal(rowEventAt([], 5, 10, 1_000_000), null);
  assert.equal(rowEventAt(events, 8_102.5, 10, 1_000_000), null, 'a row is a whole number');
  for (const step of [0, -1, Number.NaN, Infinity]) assert.equal(rowEventAt(events, 8_102, step, 1_000_000), null);
});

// ---- A bounded history for the hover (Sol's round C) ----

/** What the hover does with the history: the publications of `events` newest first (they come grouped by `wall`), the first whose events change `row`. */
const walk = (events: readonly CueEvent[], row: number, step: number): number | null => {
  for (const wall of new Set(events.map(e => e.wall))) {
    const r = rowEventAt(events.filter(e => e.wall === wall), row, step, 1_000_000);
    if (r) return r.usd;
  }
  return null;
};

test('a newer event of a bin that did not touch a row leaves that row\'s change for the hover: Sol\'s two publications', () => {
  const tr = new BookCueTracker();
  tr.observe([sol(false)], [ID], ctx(1_000));
  const first = only(tr.observe([sol(true)], [ID], ctx(2_000)));                                  // +$2M at 81,021 and -$500k at 81,031: rows 8102 and 8103 of $10
  const second = only(tr.observe([sol(true, { more: true, ts: 3_000 })], [ID], ctx(3_000)));      // $1M more at 81,021 only: row 8102
  assert.deepEqual(rowsOf([second], 10), [[8_102, 1_000_000]]);
  const hover = tr.recentEvents(ID, 'bid', 81_030, 81_040);                                       // the pointer on row 8103
  assert.equal(hover.length, 2);
  assert.ok(hover[0] === second && hover[1] === first, 'both publications, the newest first');
  assert.equal(rowEventAt([hover[0]!], 8_103, 10, 1_000_000), null, 'the newest did not touch the row');
  assert.equal(walk(hover, 8_103, 10), -500_000, 'so the hover goes on to the one before: its -$500k, seconds old');
  // The pane's present `rowChange` (`rowEvents(...).find(row)`) lands on the same one unwalked: the first row event for a row is the newest publication that reached it.
  const found = rowEvents(hover, 10, 1_000_000).find(r => r.row === 8_103);
  assert.deepEqual([found?.usd, found?.wall], [-500_000, 2_000]);
  assert.equal(walk(tr.recentEvents(ID, 'bid', 81_020, 81_030), 8_102, 10), 1_000_000, 'the row the newest touched reads the newest');
  assert.equal(tr.recent(ID, 'bid', 81_030, 81_040), second, 'recent is the single newest');
});

test('a bin with five publications keeps the last four, newest first, and the state is the same however many there were', () => {
  const tr = new BookCueTracker(), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], ctx(1_000));
  const raised: CueEvent[] = [];
  let size = tr.size();
  for (let k = 1; k <= 5; k++) {
    const x = copy(l); x.bids.set(MID - 3, 1_000_000 * (k + 1));
    raised.push(only(tr.observe([book(ID, 1_000 + k * 1_000, x)], [ID], ctx(1_000 + k * 1_000))));
    if (k === 1) size = tr.size(); else assert.deepEqual(tr.size(), size, `publication ${k}`);
  }
  const hover = tr.recentEvents(ID, 'bid', (MID - 3) * G, (MID - 2) * G);
  assert.deepEqual(hover.map(e => e.wall), [6_000, 5_000, 4_000, 3_000], 'the last four, not the one at 2,000');
  assert.ok(hover.every((e, i) => e === raised[4 - i]));
  assert.equal(tr.recent(ID, 'bid', (MID - 3) * G, (MID - 2) * G), raised[4]);
  assert.equal(size.slots, (size.bins + size.bands) * CUE_HISTORY);
});

test('recentEvents goes back four publications, not four events: bins that changed in turn', () => {
  const tr = new BookCueTracker(), A = MID - 10, B = MID - 6;
  let cur = ladder();
  tr.observe([book(ID, 1_000, cur)], [ID], ctx(1_000));
  for (let k = 1; k <= 6; k++) {                                                                  // the bins A and B change in turn, six publications
    cur = copy(cur); const bin = k % 2 ? A : B; cur.bids.set(bin, cur.bids.get(bin)! + 1_000_000);
    tr.observe([book(ID, 1_000 + k * 1_000, cur)], [ID], ctx(1_000 + k * 1_000));
  }
  const hover = tr.recentEvents(ID, 'bid', A * G, (B + 1) * G);
  assert.deepEqual(hover.map(e => [e.wall, e.lo / G]), [[7_000, B], [6_000, A], [5_000, B], [4_000, A]], 'the newest four publications, each alone');
  // A publication that touches both bins is one group.
  const both = copy(cur); both.bids.set(A, both.bids.get(A)! + 1_000_000); both.bids.set(B, both.bids.get(B)! + 1_000_000);
  tr.observe([book(ID, 8_000, both)], [ID], ctx(8_000));
  assert.deepEqual(tr.recentEvents(ID, 'bid', A * G, (B + 1) * G).map(e => [e.wall, e.lo / G]), [[8_000, A], [8_000, B], [7_000, B], [6_000, A], [5_000, B]]);
});

test('a banded book keeps the same history per band: the last four publications, newest first', () => {
  const tr = new BookCueTracker();
  tr.observe([tenBands(1_000)], [HL], ctx(1_000));
  const raised: CueEvent[] = [];
  for (let k = 1; k <= 5; k++) raised.push(only(tr.observe([tenBands(1_000 + k * 6_400, { bid: run(40, 5, { 60: (k + 1) * MILLION }) })], [HL], ctx(1_000 + k * 6_400))));
  const hover = tr.recentEvents(HL, 'bid', 60, 70);
  assert.deepEqual(hover.map(e => e.wall), [33_000, 26_600, 20_200, 13_800], 'the last four, not the first');
  assert.ok(hover.every((e, i) => e === raised[4 - i]));
  assert.equal(tr.recent(HL, 'bid', 60, 70), raised[4]);
  const size = tr.size();
  assert.equal(size.slots, (size.bins + size.bands) * CUE_HISTORY);
  // Two bands changing in turn: the newest four publications again.
  const turn = new BookCueTracker();
  turn.observe([tenBands(1_000)], [HL], ctx(1_000));
  const edits: Record<number, number | null> = {};
  for (let k = 1; k <= 6; k++) { edits[k % 2 ? 50 : 70] = (k + 1) * MILLION; turn.observe([tenBands(1_000 + k * 6_400, { bid: run(40, 5, { ...edits }) })], [HL], ctx(1_000 + k * 6_400)); }
  assert.deepEqual(turn.recentEvents(HL, 'bid', 50, 80).map(e => [e.wall, e.lo]), [[39_400, 70], [33_000, 50], [26_600, 70], [20_200, 50]]);
});

test('the history moves with its cell when the window follows the mid, up or down', () => {
  // Up: the best ask is $560 higher in the fourth publication, so the mid moves fourteen bins, past the spare cells either side of the window.
  const bidsAt = (v: number): Record<number, number> => { const m = fillBids(81_045, 50); m[81_021] = v; return m; };
  const up = new BookCueTracker();
  up.observe([venue(1_000, bidsAt(1_000_000), fillAsks(81_065, 50))], [ID], ctx(1_000));
  up.observe([venue(2_000, bidsAt(2_000_000), fillAsks(81_065, 50))], [ID], ctx(2_000));
  up.observe([venue(3_000, bidsAt(3_000_000), fillAsks(81_065, 50))], [ID], ctx(3_000));
  up.observe([venue(4_000, bidsAt(3_000_000), fillAsks(81_065 + 20 * 28, 30))], [ID], ctx(4_000));
  assert.deepEqual(up.recentEvents(ID, 'bid', 81_020, 81_040).map(e => [e.wall, e.usd]), [[3_000, 1_000_000], [2_000, 1_000_000]]);
  // Down: nine bins the other way, with an ask bin that keeps its history.
  const asksAt = (v: number): Record<number, number> => ({ ...fillAsks(81_065, 50), 81_081: v });
  const down = new BookCueTracker();
  down.observe([venue(1_000, fillBids(81_045, 50), asksAt(1_000_000))], [ID], ctx(1_000));
  down.observe([venue(2_000, fillBids(81_045, 50), asksAt(2_000_000))], [ID], ctx(2_000));
  down.observe([venue(3_000, fillBids(81_045, 50), asksAt(3_000_000))], [ID], ctx(3_000));
  down.observe([venue(4_000, fillBids(80_865, 50), { ...fillAsks(80_885, 100), 81_081: 3_000_000 })], [ID], ctx(4_000));
  assert.deepEqual(down.recentEvents(ID, 'ask', 81_080, 81_100).map(e => [e.wall, e.usd]), [[3_000, 1_000_000], [2_000, 1_000_000]]);
});

test('which change is the latest follows the order the publications were made in, not the page\'s clock: a small step back of the clock does not reverse it', () => {
  const tr = new BookCueTracker(open), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], tiny(10_000));
  const up = copy(l); up.bids.set(MID - 3, 5_000_000);
  tr.observe([book(ID, 2_000, up)], [ID], tiny(10_250));
  const down = copy(up); down.bids.set(MID - 3, 1_000_000);
  tr.observe([book(ID, 3_000, down)], [ID], tiny(10_150)); // the page's clock went back 100 ms: inside the tolerance, the same run, not a baseline
  assert.equal(tr.stats.baselines, 1);
  const events = tr.recentEvents(ID, 'bid', (MID - 3) * G, (MID - 2) * G);
  assert.deepEqual(events.map(e => [e.usd, e.wall]), [[-4_000_000, 10_150], [4_000_000, 10_250]], 'the removal was made last: it is first, with the age of its own wall');
});

test('publications are told apart by their own number, not by the page\'s clock: a wall that comes round again does not merge two of them', () => {
  const tr = new BookCueTracker(open), l = ladder();
  tr.observe([book(ID, 1_000, l)], [ID], tiny(10_000));
  const a = copy(l); a.bids.set(MID - 3, 5_000_000);
  tr.observe([book(ID, 2_000, a)], [ID], tiny(10_250));      // +$4M
  const b = copy(a); b.bids.set(MID - 3, 1_000_000);
  tr.observe([book(ID, 3_000, b)], [ID], tiny(10_500));      // -$4M
  const c = copy(b); c.bids.set(MID - 3, 3_000_000);
  tr.observe([book(ID, 4_000, c)], [ID], tiny(10_250));      // +$2M, and the clock is back at the wall of the first: inside the tolerance, still one run
  assert.equal(tr.stats.baselines, 1);
  const events = tr.recentEvents(ID, 'bid', (MID - 3) * G, (MID - 2) * G);
  assert.deepEqual(events.map(e => e.usd), [2_000_000, -4_000_000, 4_000_000], 'three publications, the latest first: the +$2M is not added to the older +$4M that has its wall');
  assert.equal(new Set(events.map(e => e.pub)).size, 3); assert.ok(events[0]!.pub > events[1]!.pub && events[1]!.pub > events[2]!.pub);
});
