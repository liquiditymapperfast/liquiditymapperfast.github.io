import test from 'node:test';
import assert from 'node:assert/strict';
import { FundingRangeSummary, fundingHeldKey, fundingStretch, type FundingPaneHeld, type FundingStretch } from '../src/app/range/funding-lines.ts';
import type { FundingRow } from '../src/app/funding.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';

const H = 3_600_000, T = Date.UTC(2026, 10, 12, 0), NOW = T + 100 * H, KEY = 'binance:BTCUSDT|1h|binance|BTCUSDT';
/** A settlement at hour `h` over the `hours` before it, at `per8h`. */
const row = (h: number, per8h: number, hours = 8): FundingRow => ({ t: T + h * H, rate: per8h * hours / 8, per8h, hours });
function held(rows: FundingRow[], o: Partial<FundingPaneHeld> = {}): FundingPaneHeld {
  return { key: KEY, venue: 'binance', coin: 'BTC', tf: '1h', rows, readFrom: T - 48 * H, premium: [], premiumMs: H, forming: null, opens: null, loading: false, failed: false, replayAt: null, ...o };
}
const sel = (h0: number, h1: number): RangeSelection => ({ t0: T + h0 * H, t1: T + h1 * H, p0: null, p1: null, live: false, draft: false, pane: 'funding', step: H });
const stretch = (h: FundingPaneHeld, h0: number, h1: number, now = NOW) => fundingStretch(h, { t0: T + h0 * H, t1: T + h1 * H }, now);
const text = (lines: ReturnType<FundingRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');
/** The pieces of the selection add up to it. */
const partitioned = (s: FundingStretch): boolean => Math.abs(s.covered + s.unread + s.afterNewest + s.gaps - s.span) < 1e-6;

test('settled funding counts each settlement for the time it paid for, inside the selection, weighted by that time', () => {
  // An eight-hour rate settling at 8 covers 0-8; a selection of 4-6 takes two hours of it, though the settlement is after the selection.
  const s = stretch(held([row(8, 0.0001)]), 4, 6);
  assert.deepEqual([s.covered / H, s.rows, s.mean, s.first?.per8h], [2, 1, 0.0001, 0.0001]);
  // Equal half-hours at +0.0001 and -0.0002 per eight hours: the time mean is -0.00005.
  const half = stretch(held([row(1, 0.0001, 1), row(2, -0.0002, 1)]), 0.5, 1.5);
  assert.ok(Math.abs(half.mean! + 0.00005) < 1e-15);
  assert.deepEqual([half.positive / H, half.negative / H], [0.5, 0.5]);
  const mixed = stretch(held([row(1, 0.0002, 1), row(5, 0, 4)]), 0, 5);
  assert.ok(Math.abs(mixed.mean! - 0.0002 / 5) < 1e-15);
  assert.deepEqual(mixed.hours, [1, 4]);
});

test('the selection splits into represented time, before the read, after the newest settlement and gaps, adding up to it', () => {
  const rows = [row(3, 0.0001, 1), row(4, 0.0001, 1), row(6, 0.0001, 1)];
  const s = stretch(held(rows, { readFrom: T + 2 * H }), 0, 10, T + 10 * H);
  assert.deepEqual([s.covered / H, s.unread / H, s.afterNewest / H, s.gaps / H], [3, 2, 4, 1]);
  assert.ok(partitioned(s));
  assert.equal(s.positive, s.covered, 'percentages of represented time only');
  assert.equal(s.settled, false, 'the newest settlement does not reach the end');
  // Sol r7: a settlement known from before the read's start represents that time; it is not also "not read".
  const known = stretch(held([row(8, 0.0001)], { readFrom: T + 4 * H }), 0, 10, T + 10 * H);
  assert.deepEqual([known.covered / H, known.unread / H, known.afterNewest / H, known.gaps / H], [8, 0, 2, 0]);
  assert.ok(partitioned(known));
  // A settlement whose interval starts before the one ahead of it settled is clipped there.
  const overlap = stretch(held([row(4, 0.0001, 4), row(6, 0.0002, 8)]), 0, 6);
  assert.equal(overlap.covered / H, 6);
  assert.ok(partitioned(overlap));
});

test('the premium is sampled from completed readings wholly inside, against the base-rate band; the reading now stays apart and expires', () => {
  const premium = [0.0001, -0.0005, 0.0003, 0.0007].map((p, h) => ({ t: T + h * H, p }));
  const s = stretch(held([row(8, 0.0001)], { premium }), 0, 4);
  assert.deepEqual(s.premium && [s.premium.n, s.premium.first, s.premium.last], [4, 0.0001, 0.0007]);
  assert.deepEqual(s.premium?.band && [s.premium.band.inside, s.premium.band.below, s.premium.band.above], [2, 1, 1], 'band -0.04% to +0.06%');
  assert.equal(stretch(held([row(8, 0.0001)], { premium }), 1, 3.5).premium?.n, 2, 'the 3:00 candle runs past the selection');
  assert.equal(stretch(held([], { venue: 'deribit', premium }), 0, 4).premium?.band, null, 'Deribit has no band');
  const forming = { rate: 0.0003, per8h: 0.0003, hours: 8, next: T + 16 * H, premium: null };
  assert.equal(stretch(held([row(8, 0.0001)], { forming }), 4, 12, T + 10 * H).forming?.per8h, 0.0003);
  assert.equal(stretch(held([row(8, 0.0001)], { forming }), 1, 3).forming, null, 'its interval does not reach into the selection');
  assert.equal(stretch(held([row(8, 0.0001)], { forming: { ...forming, next: T + 5 * H } }), 4, 4.5, T + 10 * H).forming, null, 'expired: its settlement is past');
  assert.equal(stretch(held([row(8, 0.0001)], { forming, replayAt: T + 10 * H }), 4, 12).forming, null, 'never in a replay');
});

test('who opened on Hyperliquid: a share of the hours\' amounts added up, never a mean of hourly shares; only closed hours wholly inside', () => {
  // (90, 10) and (0, 900): 9 %, not the 45 % mean of 90 % and 0 %.
  const opens = [{ t: T, longOpened: 90, shortOpened: 10 }, { t: T + H, longOpened: 0, shortOpened: 900 }, { t: T + 2 * H, longOpened: 50, shortOpened: 0 }];
  const s = stretch(held([], { venue: 'hyperliquid', opens }), 0, 2.5);
  assert.deepEqual(s.opens, { hours: 2, long: 90, short: 910 });
  const lines = new FundingRangeSummary().lines(sel(0, 2.5), held([], { venue: 'hyperliquid', opens, key: 'k' }), true, 'k', NOW);
  assert.equal(text(lines, 'fd-opens-share'), 'Buyers\' share of sided additions | 9%');
  const none = new FundingRangeSummary().lines(sel(0, 1), held([], { venue: 'hyperliquid', opens: [{ t: T, longOpened: 0, shortOpened: 0 }], key: 'k' }), true, 'k', NOW);
  assert.equal(text(none, 'fd-opens-none'), 'No sided additions estimated in these hours.');
});

test('the lines: rates first to last with the change in basis points or "unchanged"; one rate throughout; Deribit in its own words', () => {
  const rows = [row(1, 0.0001, 1), row(2, -0.0001, 1), row(3, -0.0002, 1), row(4, 0.0001, 1), row(5, -0.0001, 1)];
  const lines = new FundingRangeSummary().lines(sel(0, 5), held(rows), true, KEY, NOW);
  assert.equal(text(lines, 'fd-rate'), 'First → last settled rate | +0.0100% → −0.0100% · −2.0 bp');
  const tile = lines.find(l => l.key === 'fd-grid')!.grid![0]!.rows!;
  assert.deepEqual(tile.filter(r => /rate|run/.test(r.label) && !/mean|highest/.test(r.label)).map(r => [r.label, r.value]), [
    ['Positive settled rate', '2 h · 40% of the represented time'], ['Negative settled rate', '3 h · 60% of the represented time'], ['Longest run of negative settled rates', '2 h'],
  ]);
  const same = new FundingRangeSummary().lines(sel(0, 3), held([row(1, 0.0001, 1), row(2, 0.0002, 1), row(3, 0.0001, 1)]), true, KEY, NOW);
  assert.match(text(same, 'fd-rate')!, /· unchanged$/);
  const flat = new FundingRangeSummary().lines(sel(0, 3), held([row(1, 0.0001, 1), row(2, 0.0001, 1), row(3, 0.0001, 1)]), true, KEY, NOW);
  assert.equal(text(flat, 'fd-rate'), 'Settled rate | +0.0100% throughout the represented time');
  const deribit = new FundingRangeSummary().lines(sel(0, 3), held([row(1, 0.0001, 1), row(2, 0.0002, 1), row(3, 0.0003, 1)], { venue: 'deribit', key: 'd' }), true, 'd', NOW);
  assert.equal(text(deribit, 'h-fd-rows'), 'Completed hourly funding');
  assert.match(text(deribit, 'fd-rate')!, /^First → last hourly net rate/);
  const none = new FundingRangeSummary().lines(sel(0, 3), held([], { readFrom: T + H }), true, KEY, T + 10 * H);
  assert.equal(text(none, 'fd-rows-none'), 'No settlement held represents this selection.');
  assert.ok(none.find(l => l.key === 'fd-grid')!.grid![0]!.rows!.some(r => r.label === 'Before the read reaches'));
});

test('a kept result: kept while the pane lacks some of its settlements or readings, with its venue; never in a replay that has not reached it', () => {
  const rows = [row(1, 0.0001, 1), row(2, 0.0002, 1), row(3, 0.0003, 1)], summary = new FundingRangeSummary(), s = sel(0, 3);
  const first = summary.lines(s, held(rows), true, KEY, NOW);
  const later = summary.lines(s, held([rows[2]!]), true, KEY, NOW);
  assert.equal(text(later, 'fd-rate'), text(first, 'fd-rate'));
  assert.ok(later.some(l => l.key === 'fd-kept'));
  // Equal counts of premium readings but other ones: the kept result stands for the readings it had.
  const p = (hs: number[]) => hs.map(h => ({ t: T + h * H, p: 0.0001 }));
  const sum2 = new FundingRangeSummary();
  sum2.lines(s, held(rows, { premium: p([0, 1]) }), true, KEY, NOW);
  assert.ok(sum2.lines(s, held(rows, { premium: p([1, 2]) }), true, KEY, NOW).some(l => l.key === 'fd-kept'));
  // A kept Deribit result keeps its venue's words when the pane holds nothing.
  const sum3 = new FundingRangeSummary();
  sum3.lines(s, held(rows, { venue: 'deribit', key: 'd' }), true, 'd', NOW);
  assert.equal(text(sum3.lines(s, null, false, 'd', NOW), 'h-fd-rows'), 'Completed hourly funding');
  const replay = summary.lines(s, held([], { replayAt: T - H }), true, KEY, T - H);
  assert.equal(text(replay, 'fd-none'), 'This selection has not begun yet.');
  assert.match(text(summary.lines(s, held(rows), true, 'other', NOW), 'fd-stale')!, /last drew another market/);
  assert.equal(text(new FundingRangeSummary().lines(s, null, true, KEY, NOW, '', true), 'fd-none'), 'No venue here lists a perpetual of this coin.');
});

test('review: a corrected interval replaces a kept result; reading funding; shares of represented time; a reading now outside the selection', () => {
  // Every four hours with 04:00 skipped: the 08:00 row first reads 8 hours (0-8); a selection 1-3 lies inside it. Corrected to four hours
  // (4-8), the pane still holds the 08:00 settlement: no loss, and the corrected answer (nothing represents 1-3) stands.
  const summary = new FundingRangeSummary(), s = sel(1, 3);
  summary.lines(s, held([row(-4, 0.0001, 4), row(0, 0.0001, 4), row(8, 0.0002, 8)]), true, KEY, NOW);
  const corrected = summary.lines(s, held([row(-4, 0.0001, 4), row(0, 0.0001, 4), row(8, 0.0001, 4), row(12, 0.0001, 4)]), true, KEY, NOW);
  assert.equal(corrected.find(l => l.key === 'fd-kept'), undefined);
  assert.equal(text(corrected, 'fd-rows-none'), 'No settlement held represents this selection.');
  // Still reading: said.
  assert.ok(new FundingRangeSummary().lines(s, held([], { loading: true, readFrom: null }), true, KEY, NOW).some(l => l.key === 'fd-reading'));
  // A gap: the shares are of the represented time (2 h), not of the selection (3 h).
  const gap = new FundingRangeSummary().lines(sel(0, 3), held([row(1, 0.0001, 1), row(3, -0.0001, 1)]), true, KEY, NOW);
  const rows = gap.find(l => l.key === 'fd-grid')!.grid![0]!.rows!;
  assert.equal(rows.find(r => r.label === 'Positive settled rate')?.value, '60 min · 50% of the represented time');
  // An unexpired reading now whose interval is after the selection: not shown.
  const forming = { rate: 0.0003, per8h: 0.0003, hours: 8, next: T + 16 * H, premium: null };
  assert.equal(stretch(held([row(8, 0.0001)], { forming }), 1, 3, T + 10 * H).forming, null);
});

test('Deribit: a tiny hourly rate keeps its digits; the time after its newest record is said in its own words', () => {
  // A record of 1.8e-7 per eight hours (an APR of 0.02 %), the hour after it not recorded yet.
  const lines = new FundingRangeSummary().lines(sel(0, 1.5), held([row(1, 0.00000018, 1)], { venue: 'deribit', key: 'd' }), true, 'd', T + 1.5 * H);
  assert.equal(text(lines, 'fd-rate'), 'Hourly net rate | +0.00002% throughout the represented time');
  assert.ok(lines.find(l => l.key === 'fd-grid')!.grid![0]!.rows!.some(r => r.label === 'After the newest hourly record held'));
});

test('the key names the market, timeframe, venue and listing', () => {
  assert.equal(fundingHeldKey({ marketId: 'binance:BTCUSDT', timeframe: '1h' }, 'binance', 'BTCUSDT'), KEY);
});
