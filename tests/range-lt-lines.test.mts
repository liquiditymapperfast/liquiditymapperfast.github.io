import test from 'node:test';
import assert from 'node:assert/strict';
import { LtRangeSummary, ltHeldKey, ltStretch, type LtPaneHeld } from '../src/app/range/lt-lines.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';

const M = 60_000, T = Date.UTC(2026, 10, 13, 0), NOW = T + 600 * M;
const SET = { halfLifeBp: 10, minUsd: 0, maxUsd: 0, average: false };
const IDS = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
const KEY = ltHeldKey(IDS, SET);
/** Windows of `step` minutes from minute `from`, bids and asks given, each venue's part (NaN where it had nothing). */
function held(o: { from?: number; step?: number; bid: number[]; ask: number[]; missing?: [number, number][]; approx?: number[]; parts?: boolean; ids?: string[]; shown?: number; replayAt?: number | null; times?: number[]; answeredAt?: number }): LtPaneHeld {
  const step = (o.step ?? 1) * M, n = o.bid.length, ids = o.ids ?? IDS;
  const times = Float64Array.from(o.times ?? Array.from({ length: n }, (_, i) => T + ((o.from ?? 0) + i * (o.step ?? 1)) * M));
  const pb = new Float32Array(ids.length * n), pa = new Float32Array(ids.length * n);
  for (let m = 0; m < ids.length; m++) for (let k = 0; k < n; k++) { pb[m * n + k] = o.bid[k]! / ids.length; pa[m * n + k] = o.ask[k]! / ids.length; }
  for (const [m, k] of o.missing ?? []) { pb[m * n + k] = NaN; pa[m * n + k] = NaN; }
  const approx = new Uint8Array(n); for (const k of o.approx ?? []) approx[k] = 1;
  return { key: ltHeldKey(ids, SET), ids, names: ids.map(id => id.split(':')[0]!), ...SET, minApplied: SET.minUsd, maxApplied: SET.maxUsd, answeredAt: o.answeredAt ?? NOW + 3_600_000, times, bid: Float32Array.from(o.bid), ask: Float32Array.from(o.ask), parts: o.parts === false ? null : { bid: pb, ask: pa },
    approx, stepMs: step, shown: o.shown ?? n, replayAt: o.replayAt ?? null };
}
const sel = (m0: number, m1: number): RangeSelection => ({ t0: T + m0 * M, t1: T + m1 * M, p0: null, p1: null, live: false, draft: false, pane: 'lt', step: M });
const text = (lines: ReturnType<LtRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');
const tile = (lines: ReturnType<LtRangeSummary['lines']>, key: string) => lines.flatMap(l => l.grid ?? []).find(g => g.key === key);

test('a window lacking a venue, and time no window covers, are said and never measured', () => {
  // Five one-minute windows from minute 0, then a gap to minute 8; window 2 lacks bybit.
  const h = held({ times: [0, 1, 2, 3, 4, 8].map(m => T + m * M), bid: [100, 100, 10, 100, 100, 100], ask: [50, 50, 5, 50, 50, 50], missing: [[1, 2]] });
  const s = ltStretch(h, sel(0, 10), NOW);
  assert.deepEqual([s.span / M, s.covered / M, s.lacking / M, s.none / M, s.forming], [10, 5, 1, 4, 0]);
  assert.equal(s.covered + s.lacking + s.none + s.forming, s.span, 'the partition adds up');
  assert.equal(s.bid!.mean, 100, 'the window lacking a venue (10) is not averaged in');
  const lines = new LtRangeSummary().lines(sel(0, 10), h, true, KEY, NOW);
  assert.equal(text(lines, 'lt-cover'), 'Windows holding all 2 venues cover 5 min of 10 min · 5 included windows · missing a venue: 1 min (bybit) · no window held: 4 min');
});

test('each window counts for the time it overlaps; the imbalance mean is of each window\'s own imbalance, not of the means', () => {
  // Fifteen-minute windows at 0 and 15; the selection [10, 30) takes 5 min of the first and 15 of the second.
  const h = held({ step: 15, bid: [300, 100], ask: [100, 300] });
  const s = ltStretch(h, sel(10, 30), NOW);
  assert.equal(s.bid!.mean, (5 * 300 + 15 * 100) / 20);
  assert.equal(s.ask!.mean, (5 * 100 + 15 * 300) / 20);
  // Windows of 900/100 (+0.8) and 10/90 (-0.8): the mean of their imbalances is 0; the imbalance of the mean bids and asks (455 / 95) is +0.65.
  const lop = ltStretch(held({ step: 15, bid: [900, 10], ask: [100, 90] }), sel(0, 30), NOW);
  assert.ok(Math.abs(lop.imbalance!.mean) < 1e-12);
  assert.ok(Math.abs((lop.bid!.mean - lop.ask!.mean) / (lop.bid!.mean + lop.ask!.mean) - 360 / 550) < 1e-12, 'which is not what is reported');
  assert.deepEqual([lop.imbalance!.bidHeavier / M, lop.imbalance!.askHeavier / M], [15, 15]);
  assert.deepEqual([s.bid!.first, s.bid!.last, s.bid!.low, s.bid!.high], [300, 100, 100, 300]);
});

test('the window under way is left out, and a replay never reads past its cut', () => {
  // One-minute windows to minute 599; at 599:30 the window from 599 is under way.
  const h = held({ from: 590, bid: Array(10).fill(10), ask: Array(10).fill(10) });
  const s = ltStretch(h, sel(595, 601), NOW - 30_000);
  assert.deepEqual([s.covered / M, s.forming / M, s.settled], [4, 0.5, false]);
  // A replay at minute 593 shows the windows that had ended by then (shown = 3): the rest are not read.
  const r = held({ from: 590, bid: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ask: Array(10).fill(10), shown: 3, replayAt: T + 593 * M });
  const rs = ltStretch(r, sel(590, 600), T + 593 * M);
  assert.deepEqual([rs.covered / M, rs.bid!.last, rs.span / M], [3, 3, 3]);
});

test('approximation is said only for windows inside the selection; an answer without parts for several venues is flagged', () => {
  const h = held({ bid: Array(10).fill(10), ask: Array(10).fill(10), approx: [8] });
  assert.equal(ltStretch(h, sel(0, 5), NOW).approx, 0);
  assert.equal(ltStretch(h, sel(5, 10), NOW).approx, M);
  const lines = new LtRangeSummary().lines(sel(5, 10), h, true, KEY, NOW);
  assert.ok(text(lines, 'lt-approx'));
  assert.ok(!text(new LtRangeSummary().lines(sel(0, 5), h, true, KEY, NOW), 'lt-approx'));
  const blind = held({ bid: Array(10).fill(10), ask: Array(10).fill(10), parts: false });
  assert.equal(ltStretch(blind, sel(0, 5), NOW).unverified, true);
  assert.ok(text(new LtRangeSummary().lines(sel(0, 5), blind, true, KEY, NOW), 'lt-unverified'));
  // One venue: its windows are its own, nothing to verify.
  const one = held({ bid: Array(10).fill(10), ask: Array(10).fill(10), parts: false, ids: ['binance:BTCUSDT'] });
  assert.equal(ltStretch(one, sel(0, 5), NOW).unverified, false);
});

test('another key is stale; a settled result is kept while the pane holds less of it, never across a replay\'s moment', () => {
  const summary = new LtRangeSummary(), h = held({ bid: Array(10).fill(100), ask: Array(10).fill(50) });
  assert.ok(text(summary.lines(sel(0, 5), h, false, ltHeldKey(IDS, { ...SET, halfLifeBp: 25 }), NOW), 'lt-stale'), 'another half-life, pane hidden');
  assert.equal(text(summary.lines(sel(0, 5), h, true, ltHeldKey(IDS, { ...SET, halfLifeBp: 25 }), NOW), 'lt-none'), 'Liquidity tracker is collecting…', 'a pane in view is reading the new settings, never "show it"');
  const first = summary.lines(sel(0, 5), h, true, KEY, NOW);
  assert.equal(tile(first, 'bid')?.value, '$100');
  // The view moved away: the pane now holds windows from minute 300 only.
  const away = held({ from: 300, bid: Array(10).fill(7), ask: Array(10).fill(7) });
  const kept = summary.lines(sel(0, 5), away, true, KEY, NOW + M);
  assert.ok(text(kept, 'lt-kept'));
  assert.equal(tile(kept, 'bid')?.value, '$100');
  // In a replay at an earlier moment, the live result is not kept.
  const replay = held({ from: 300, bid: Array(10).fill(7), ask: Array(10).fill(7), replayAt: T + 400 * M, shown: 10 });
  assert.ok(!text(summary.lines(sel(0, 5), replay, true, KEY, T + 400 * M, '', '', true), 'lt-kept'));
  // Nothing held in a replay: the live result is not kept either (the mode is the page's, not the snapshot's).
  assert.ok(!text(summary.lines(sel(0, 5), null, true, KEY, T + 400 * M, '', '', true), 'lt-kept'));
});

test('no venue, nothing drawn, a hidden pane and a selection not begun say so; tiles carry first, last and range', () => {
  const summary = new LtRangeSummary(), h = held({ bid: [100, 120, 90], ask: [50, 60, 70] });
  assert.equal(text(summary.lines(sel(0, 3), null, true, KEY, NOW, '', 'No market is chosen: tick some under Choose….'), 'lt-none'), 'No market is chosen: tick some under Choose….', 'the reason the pane gives, whatever it is');
  assert.equal(text(summary.lines(sel(0, 3), null, true, KEY, NOW), 'lt-none'), 'Liquidity tracker is collecting…');
  assert.ok(text(summary.lines(sel(0, 3), h, false, KEY, NOW), 'lt-hidden'));
  assert.equal(text(summary.lines(sel(700, 710), h, true, KEY, NOW), 'lt-none'), 'This selection has not begun yet.');
  const lines = summary.lines(sel(0, 3), h, true, KEY, NOW);
  const bid = tile(lines, 'bid')!;
  assert.deepEqual(bid.rows!.map(r => r.value), ['$100 → $90', '−$10', '$90 – $120']);
});

test('one window: its value alone, no first and last, change or range', () => {
  const lines = new LtRangeSummary().lines(sel(0, 1), held({ bid: [100, 100], ask: [50, 50] }), true, KEY, NOW);
  assert.deepEqual(tile(lines, 'bid')?.rows, []);
  assert.equal(text(lines, 'lt-imb'), 'Imbalance of the one window | +33.3 %');
  assert.ok(!text(lines, 'lt-imb-move') && !text(lines, 'lt-imb-split'));
});

test('a window read mid-way stays open however late it is read; sub-minute parts are said; no parts for several venues sums up nothing', () => {
  // Answered at minute 0.5 (the window [0, 1) under way), read at minute 2: it is not a closed window now.
  const early = held({ bid: [100], ask: [50], answeredAt: T + 30_000 });
  const s = ltStretch(early, sel(0, 2), T + 2 * M);
  assert.deepEqual([s.covered, s.forming / M, s.none / M, s.settled], [0, 1, 1, false], 'the open window is one window; the time after it was never read');
  // 58 min 45 s elapsed: 1 min covered, 45 s open, the rest no window: the 45 s are said.
  const lines = new LtRangeSummary().lines(sel(0, 60), held({ from: 57, bid: [10], ask: [10] }), true, KEY, T + 58 * M + 45_000);
  assert.match(text(lines, 'lt-cover') ?? '', /open window excluded: under 1 min/);
  const blind = new LtRangeSummary().lines(sel(0, 5), held({ bid: Array(10).fill(10), ask: Array(10).fill(10), parts: false }), true, KEY, NOW);
  assert.ok(text(blind, 'lt-unverified') && !blind.some(l => l.grid), 'no figures claim a set of venues');
  assert.match(text(blind, 'lt-cover') ?? '', /^Windows cover/);
});

test('time with each side heavier shares one denominator with its label: equal sides count for neither', () => {
  // Four one-minute windows: bids heavier, asks heavier, two equal.
  const lines = new LtRangeSummary().lines(sel(0, 4), held({ bid: [20, 10, 10, 10], ask: [10, 20, 10, 10] }), true, KEY, NOW);
  assert.equal(text(lines, 'lt-imb-bids'), 'Time with bids heavier | 25 % · 1 min');
  assert.equal(text(lines, 'lt-imb-asks'), 'Time with asks heavier | 25 % · 1 min');
  assert.ok(!lines.some(l => l.kind === 'split'), 'no bar that normalises the ties away');
  // Tiny imbalances get two decimals rather than 0.0 % -> 0.0 %.
  const tiny = new LtRangeSummary().lines(sel(0, 2), held({ bid: [100, 100.04], ask: [100, 100] }), true, KEY, NOW);
  assert.match(text(tiny, 'lt-imb-move') ?? '', /0\.00 % → \+0\.02 %/);
});
