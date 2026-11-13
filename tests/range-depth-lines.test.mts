import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthRangeSummary, depthHeldKey, depthLiqStretch, depthStretch, type DepthLiqRow, type DepthPaneHeld } from '../src/app/range/depth-lines.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';

const M = 60_000, T = Date.UTC(2026, 10, 13, 0), NOW = T + 600 * M;
const IDS = ['binance:BTCUSDT', 'bybit:BTCUSDT'], RADII = [0.005, 0.02];
/** `w` display columns of `colMin` minutes each from minute `from`; per column [bid, ask] of each band; `present` per column (default all). */
function book(cols: [number, number][][], o: { from?: number; colMin?: number; t0?: number; t1?: number; present?: number[]; centred?: number[]; stepMs?: number; coins?: boolean; focus?: number; answeredAt?: number } = {}): DepthPaneHeld {
  const w = cols.length, k = RADII.length, colMin = o.colMin ?? 1, t0 = o.t0 ?? T + (o.from ?? 0) * M;
  const bid = new Float32Array(w * k), ask = new Float32Array(w * k);
  cols.forEach((c, x) => c.forEach(([b, a], j) => { bid[x * k + j] = b; ask[x * k + j] = a; }));
  return { key: depthHeldKey('book', IDS, RADII), source: 'book', ids: IDS, t0, t1: o.t1 ?? t0 + w * colMin * M, w, radii: RADII, bid, ask, bidCoin: bid.map(v => v / 50_000), askCoin: ask.map(v => v / 50_000),
    present: Uint16Array.from(o.present ?? cols.map(() => IDS.length)), centred: Uint8Array.from(o.centred ?? cols.map(() => 1)), stepMs: o.stepMs ?? M, answeredAt: o.answeredAt ?? Infinity,
    rows: null, buckets: null, omitted: [], coins: o.coins ?? false, coin: 'BTC', focus: o.focus ?? 1 };
}
const flat = (n: number, b: number, a: number): [number, number][][] => Array.from({ length: n }, () => [[b / 2, a / 2], [b, a]]);
const sel = (m0: number, m1: number): RangeSelection => ({ t0: T + m0 * M, t1: T + m1 * M, p0: null, p1: null, live: false, draft: false, pane: 'depth', step: M });
const text = (lines: ReturnType<DepthRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');
const KEY = depthHeldKey('book', IDS, RADII), LKEY = depthHeldKey('liq', [], RADII);

test('a column lacking a venue, one with no centre, one with no book and time outside the columns drawn are said, never measured', () => {
  // Ten one-minute columns from minute 0: column 3 lacks bybit, column 5 has no book at all, column 7 no price centre.
  const cols = flat(10, 100, 100); cols[3] = [[1, 1], [2, 2]];
  const h = book(cols, { present: [2, 2, 2, 1, 2, 0, 2, 2, 2, 2], centred: [1, 1, 1, 1, 1, 0, 1, 0, 1, 1] });
  const s = depthStretch(h, sel(0, 14), NOW);
  assert.deepEqual([s.span / M, s.covered / M, s.lacking / M, s.uncentred / M, s.none / M, s.outside / M, s.open], [14, 7, 1, 1, 1, 4, 0]);
  assert.equal(s.covered + s.lacking + s.uncentred + s.none + s.outside + s.open, s.span);
  assert.equal(s.bands[1]!.bid, 100, 'the column lacking a venue (2) is not averaged in');
  const lines = new DepthRangeSummary().lines(sel(0, 14), h, true, KEY, NOW);
  assert.equal(text(lines, 'dp-cover'), 'All 2 venues represented: 7 min of 14 min · lacking a venue: 1 min · no price centre: 1 min · no book: 1 min · outside the columns drawn: 4 min');
  assert.match(text(lines, 'dp-measured') ?? '', /^Measured columns: first .*, last /);
});

test('a book present with nothing inside a band is a zero; nested bands are each their own mean, never added; the watched band\'s imbalance', () => {
  const h = book([[[0, 0], [50, 70]], [[10, 20], [60, 80]]], { focus: 0 });
  const s = depthStretch(h, sel(0, 2), NOW);
  assert.deepEqual(s.bands.map(b => [b.bid, b.ask]), [[5, 10], [55, 75]]);
  assert.equal(s.bands[0]!.imbalance, -1 / 3, 'the empty column has no imbalance: the mean is of the other alone');
  const lines = new DepthRangeSummary().lines(sel(0, 2), h, true, KEY, NOW);
  assert.equal(text(lines, 'dp-focus'), 'Watched band ±0.5 %: mean imbalance | −33.3 %');
  assert.deepEqual(lines.flatMap(l => l.grid ?? []).map(g => g.rows!.length), [3, 3], 'three rows a band: means, bids, asks');
});

test('a display column touching an unfinished book minute (by the clock, a replay\'s moment or the answer) is not measured, fractional edges too', () => {
  // Two-minute display columns over one-minute book columns: at 600:30, the column [599, 601) holds the book minute under way.
  const h = book(flat(5, 100, 100), { from: 591, colMin: 2 });
  const s = depthStretch(h, sel(591, 601), NOW + 30_000);
  assert.deepEqual([s.covered / M, s.open / M, s.settled], [8, 1.5, false]);
  const r = depthStretch(h, sel(591, 601), T + 596.5 * M);
  assert.deepEqual([r.covered / M, r.open / M, r.span / M], [4, 1.5, 5.5]);
  // A column ending half a millisecond past a minute's start touches that minute: at that minute's start it is not measured.
  const frac = book([[[1, 1], [500, 500]], [[1, 1], [500, 500]]], { t0: T, t1: T + 2 * M + 1 });
  assert.equal(depthStretch(frac, { t0: T, t1: T + M }, T + M).covered, 0, 'the column [0, 60 000.5) holds the minute from 60 000');
  // An answer made at 600:30 holds the minute from 600 half-read: read at 605 it is still not a closed column.
  const early = book(flat(10, 100, 100), { from: 595, answeredAt: T + 600.5 * M });
  const e = depthStretch(early, sel(595, 605), T + 605 * M);
  assert.deepEqual([e.covered / M, e.open / M, e.none / M], [5, 1, 4], 'only the minute begun by the answer is open; the minutes after it were never read');
});

test('tracked liquidation levels: the snapshots actually in force, their expiry, first and last, coverage even when none is in force', () => {
  const row = (m: number, long: number, short: number): DepthLiqRow => ({ asOf: T + (m - 2) * M, fetchedAt: T + m * M, long: [long, long * 2], short: [short, short * 2], longCoin: [long / 50_000, long / 25_000], shortCoin: [short / 50_000, short / 25_000] });
  const liq = (rows: DepthLiqRow[], t1 = T + 200 * M): DepthPaneHeld => ({ key: LKEY, source: 'liq', ids: [], t0: T, t1, w: 20, radii: RADII, bid: new Float32Array(40), ask: new Float32Array(40), bidCoin: new Float32Array(40), askCoin: new Float32Array(40),
    present: null, centred: null, stepMs: 0, answeredAt: Infinity, rows, buckets: [0, 1], omitted: [], coins: false, coin: 'BTC', focus: 1 });
  const h = liq([row(0, 10, 20), row(4, 30, 10)]);
  const s = depthLiqStretch(h, sel(0, 10), NOW);
  assert.equal(s.rows.length, 2);
  assert.deepEqual([s.inForce / M, s.none / M], [10, 0]);
  assert.deepEqual(s.bands.map(b => [b.firstLong, b.lastLong, b.firstShort, b.lastShort]), [[10, 30, 20, 10], [20, 60, 40, 20]]);
  // A snapshot fetched at minute 4 was not in force in [0, 1).
  assert.equal(depthLiqStretch(liq([row(4, 30, 10)]), sel(0, 1), NOW).rows.length, 0);
  // A snapshot fetched at 0 expires at 90 min: none is in force in [91, 92).
  const old = depthLiqStretch(liq([row(0, 10, 20)]), sel(91, 92), NOW);
  assert.deepEqual([old.rows.length, old.none / M], [0, 1]);
  // Held columns end at 10 min; a selection [0, 20) with no snapshot in force: both durations are said.
  const empty = new DepthRangeSummary().lines(sel(0, 20), liq([], T + 10 * M), true, LKEY, NOW);
  assert.ok(text(empty, 'dp-empty'));
  assert.equal(text(empty, 'dp-cover'), 'Snapshots in force for 0 min of 20 min · no snapshot in force: 10 min · outside the columns drawn: 10 min');
  // The memo is never older than a second: a replay stepping back before a fetch drops the snapshot again.
  const summary = new DepthRangeSummary(), mid = liq([row(0, 1, 1), { ...row(0, 2, 2), fetchedAt: T + 31_500 }]);
  const at34 = summary.lines({ t0: T, t1: T + M, p0: null, p1: null, live: false, draft: false }, mid, true, LKEY, T + 34_000);
  const at31 = summary.lines({ t0: T, t1: T + M, p0: null, p1: null, live: false, draft: false }, mid, true, LKEY, T + 31_000);
  assert.match(text(at34, 'dp-status') ?? '', /2 snapshots/);
  assert.match(text(at31, 'dp-status') ?? '', /1 snapshot in force/);
  const lines = new DepthRangeSummary().lines(sel(0, 10), h, true, LKEY, NOW);
  assert.ok(text(lines, 'dp-when')?.includes('fetched'));
  assert.match(text(lines, 'dp-how') ?? '', /not liquidations that happened/);
});

test('another source or other bands is stale when hidden and waits when shown; an empty reason is said; one precision a band', () => {
  const summary = new DepthRangeSummary(), h = book(flat(5, 100, 100));
  const other = depthHeldKey('book', IDS, [0.01]);
  assert.ok(text(summary.lines(sel(0, 5), h, false, other, NOW), 'dp-stale'));
  assert.equal(text(summary.lines(sel(0, 5), h, true, other, NOW), 'dp-wait'), 'Depth history is collecting…');
  assert.equal(text(summary.lines(sel(0, 5), h, true, LKEY, NOW), 'dp-wait'), 'The liquidation levels\' history is loading…');
  assert.equal(text(summary.lines(sel(0, 5), null, true, KEY, NOW, '', 'Liquidation levels are for BTC only for now.'), 'dp-none'), 'Liquidation levels are for BTC only for now.');
  assert.equal(text(summary.lines(sel(700, 705), h, true, KEY, NOW), 'dp-none'), 'This selection has not begun yet.');
  // $1,240.0M -> $1,162.8M reads as such (not $1.2B -> $1.2B).
  const big = book([[[1, 1], [1.24e9, 1e9]], [[1, 1], [1.1628e9, 1e9]]]);
  const row = new DepthRangeSummary().lines(sel(0, 2), big, true, KEY, NOW).flatMap(l => l.grid ?? [])[1]!.rows!.find(r => r.label === 'Bids first → last')!;
  assert.equal(row.value, '$1,240.0M → $1,162.8M (−$77.2M)');
});

test('first and last come from columns wholly inside the selection; zoomed in columns read in seconds; one venue; no forming in a replay', () => {
  // Half-minute display columns from minute 99:30: the first column [99:30, 100:00) lies before the selection [100, 102).
  const cols: [number, number][][] = [[[1, 1], [999, 1]], [[1, 1], [100, 1]], [[1, 1], [110, 1]], [[1, 1], [120, 1]], [[1, 1], [130, 1]], [[1, 1], [777, 1]]];
  const h = book(cols, { t0: T + 99.5 * M, t1: T + 102.5 * M });
  const s = depthStretch(h, sel(100, 102), NOW);
  assert.deepEqual([s.bands[1]!.firstBid, s.bands[1]!.lastBid], [100, 130], 'never the columns beyond the selection');
  const lines = new DepthRangeSummary().lines(sel(100, 102), h, true, KEY, NOW);
  assert.match(text(lines, 'dp-status') ?? '', /columns of 30 s at this zoom/);
  // A straddling column is used only when no column lies wholly inside.
  const wide = book([[[1, 1], [50, 1]], [[1, 1], [60, 1]]], { t0: T + 99.5 * M, colMin: 1 });
  assert.equal(depthStretch(wide, { t0: T + 100 * M, t1: T + 100.75 * M }, NOW).bands[1]!.firstBid, 50);
  const one = { ...book(flat(3, 10, 10)), ids: ['binance:BTCUSDT'], present: Uint16Array.from([1, 1, 1]), key: depthHeldKey('book', ['binance:BTCUSDT'], RADII) };
  assert.match(text(new DepthRangeSummary().lines(sel(0, 3), one, true, one.key, NOW), 'dp-cover') ?? '', /^Columns cover 3 min of 3 min/);
  const replay = new DepthRangeSummary().lines(sel(0, 5), book(flat(5, 10, 10)), true, KEY, T + 3 * M, '', '', true);
  assert.ok(!(text(replay, 'dp-title') ?? '').includes('forming'), 'a replay selection is never forming');
});

test('a selection whose columns all lack a price centre says so', () => {
  const one = { ...book(flat(3, 10, 10), { centred: [0, 0, 0] }), ids: ['binance:BTCUSDT'], present: Uint16Array.from([1, 1, 1]), key: depthHeldKey('book', ['binance:BTCUSDT'], RADII) };
  const lines = new DepthRangeSummary().lines(sel(0, 3), one, true, one.key, NOW);
  assert.equal(text(lines, 'dp-empty'), 'No column of this selection has a price centre: one side of the book is empty.');
});
