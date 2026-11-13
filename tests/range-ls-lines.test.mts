import test from 'node:test';
import assert from 'node:assert/strict';
import { LsRangeSummary, lsHeldKey, lsStretch, type LsPaneHeld } from '../src/app/range/ls-lines.ts';
import type { LsPoint, LsPopulation, LsSeries } from '../src/shared/long-short.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';

const M = 60_000, T = Date.UTC(2026, 10, 12, 0), NOW = T + 1000 * M;
const pts = (...xs: [number, number][]): LsPoint[] => xs.map(([m, long]) => ({ t: T + m * M, long }));
const series = (id: string, points: LsPoint[], o: Partial<LsSeries> = {}): LsSeries => ({ id, population: 'accounts', periodMs: 5 * M, points, status: 'ok', ...o });
const KEY = 'binance:BTCUSDT|5m|accounts|binance:BTCUSDT,bybit:BTCUSDT';
function held(list: LsSeries[], o: Partial<LsPaneHeld> = {}): LsPaneHeld {
  return { key: KEY, tf: '5m', tfMs: 5 * M, ids: list.map(s => s.id), series: list, asked: { from: T - 60 * M, to: NOW }, loading: false, replayAt: null, ...o };
}
const sel = (m0: number, m1: number): RangeSelection => ({ t0: T + m0 * M, t1: T + m1 * M, p0: null, p1: null, live: false, draft: false, pane: 'ls', step: 5 * M });
const venue = (h: LsPaneHeld, m0: number, m1: number, id: string, now = NOW) => lsStretch(h, { t0: T + m0 * M, t1: T + m1 * M }, now).venues.find(v => v.id === id)!;
const text = (lines: ReturnType<LsRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');

test('a reading counts for the time its drawn step covers: until the next within three periods, else one period; a gap is no reading', () => {
  // Readings at 0 and 15 (five-minute period) meet: the first holds until 15. At 0 and 20 they do not: the first ends at 5.
  const joined = venue(held([series('binance:BTCUSDT', pts([0, 0.6], [15, 0.4]))]), 0, 25, 'binance:BTCUSDT');
  assert.deepEqual([joined.covered / M, joined.readings, joined.above / M, joined.below / M], [20, 2, 15, 5]);
  const apart = venue(held([series('binance:BTCUSDT', pts([0, 0.6], [20, 0.4]))]), 0, 25, 'binance:BTCUSDT');
  assert.deepEqual([apart.covered / M, apart.span / M], [10, 25], 'the gap from 5 to 20 is not covered, not 50 %');
  // A reading on its own ends one period after it: a selection in the later hold the popup still shows has no coverage.
  const lone = venue(held([series('binance:BTCUSDT', pts([0, 0.6]))]), 6, 14, 'binance:BTCUSDT');
  assert.deepEqual([lone.covered, lone.mean, lone.first], [0, null, null]);
  // A reading before the selection counts only for the part of its step inside it.
  const before = venue(held([series('binance:BTCUSDT', pts([0, 0.7], [10, 0.5]))]), 5, 15, 'binance:BTCUSDT');
  assert.deepEqual([before.covered / M, before.first?.long, before.above / M, before.even / M], [10, 0.7, 5, 5]);
});

test('time mean, range, lean and the longest unbroken stretch; a gap or 50 % breaks a stretch', () => {
  const v = venue(held([series('binance:BTCUSDT', pts([0, 0.52], [5, 0.56], [10, 0.5], [15, 0.54], [20, 0.53], [40, 0.45]))]), 0, 45, 'binance:BTCUSDT');
  // Steps: 0-5 .52, 5-10 .56, 10-15 .50, 15-20 .54, 20-25 .53 (next at 40 is past the hold), 40-45 .45.
  assert.equal(v.covered / M, 30);
  assert.ok(Math.abs(v.mean! - (0.52 + 0.56 + 0.5 + 0.54 + 0.53 + 0.45) / 6) < 1e-12);
  assert.deepEqual([v.low, v.high, v.above / M, v.below / M, v.even / M], [0.45, 0.56, 20, 5, 5]);
  assert.deepEqual([v.longestAbove / M, v.longestBelow / M], [10, 5], '0-10 then 50 % breaks it; 15-25 is also 10');
  assert.deepEqual([v.first?.long, v.last?.long], [0.52, 0.45]);
});

test('venues of one population are compared only where all are drawn at both moments; another population, stale or pending venues never join', () => {
  const list = [
    series('binance:BTCUSDT', pts([0, 0.60], [5, 0.62], [10, 0.63])),
    series('bybit:BTCUSDT', pts([0, 0.55], [5, 0.54], [10, 0.52])),
    series('okx:BTC-USDT-SWAP', pts([0, 0.50], [10, 0.50]), { status: 'stale' }),
    series('bitget:BTCUSDT', pts([0, 0.7], [10, 0.7]), { population: 'topPositions' }),
  ];
  const s = lsStretch(held(list), { t0: T, t1: T + 15 * M }, NOW);
  assert.equal(s.spreads.length, 1);
  const [spread] = s.spreads;
  assert.deepEqual(spread!.ids, ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  assert.ok(Math.abs(spread!.start - 0.05) < 1e-12 && Math.abs(spread!.end - 0.11) < 1e-12);
  assert.deepEqual(spread!.changes.map(c => Math.round(c * 1000)), [30, -30]);
  const lines = new LsRangeSummary().lines(sel(0, 15), held(list), true, KEY, NOW);
  assert.ok(lines.some(l => l.key === 'h-ls-accounts') && lines.some(l => l.key === 'h-ls-topPositions'), 'each population under its own heading');
  assert.equal(text(lines, 'ls-spread-accounts'), 'Highest minus lowest long share at those moments | 5.0 pp → 11.0 pp');
  assert.deepEqual([text(lines, 'ls-shared-accounts-binance:BTCUSDT'), text(lines, 'ls-shared-accounts-bybit:BTCUSDT')], ['Binance | +3.00 pp', 'Bybit | −3.00 pp']);
  assert.equal(lines.find(l => l.key === 'ls-spread-topPositions'), undefined, 'one venue: no spread');
  assert.match(text(lines, 'ls-okx:BTC-USDT-SWAP')!, /earlier readings/);
  assert.ok(!lines.some(l => /all venues|average/i.test(l.cells.join(' ')) && l.kind !== 'note'), 'no share of all venues');
});

test('a venue with no reading for the stretch says why, never 0 % or 50 %; one reading claims no change', () => {
  const list = [
    series('binance:BTCUSDT', pts([0, 0.6])),
    series('bybit:BTCUSDT', [], { status: 'failed' }),
    series('okx:BTC-USDT-SWAP', [], { status: 'serverOnly', population: null }),
    series('gateio:BTC_USDT', pts([100, 0.5])),
  ];
  const lines = new LsRangeSummary().lines(sel(0, 10), held(list), true, KEY, NOW);
  assert.equal(text(lines, 'ls-binance:BTCUSDT'), 'Binance | 60.0% | one reading · 5 min of 10 min covered');
  assert.equal(text(lines, 'ls-bybit:BTCUSDT'), 'Bybit | could not be read | ');
  assert.equal(text(lines, 'ls-okx:BTC-USDT-SWAP'), 'OKX | not readable by a web page | ');
  assert.equal(text(lines, 'ls-gateio:BTC_USDT'), 'Gate.io | no reading held for this time | ');
});

test('a settled closed result is kept when the view moves away, and not replaced by coarser readings or less coverage', () => {
  const fine = [series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62], [10, 0.64]))];
  const summary = new LsRangeSummary(), s = sel(0, 15);
  const first = summary.lines(s, held(fine), true, KEY, NOW);
  assert.equal(summary.lines(s, held(fine), true, KEY, NOW).length, first.length);
  // A wider view: the venue read in hourly readings now; the kept five-minute result stands.
  const coarse = [series('binance:BTCUSDT', pts([0, 0.61]), { periodMs: 60 * M })];
  const later = summary.lines(s, held(coarse), true, KEY, NOW);
  assert.equal(text(later, 'ls-binance:BTCUSDT'), text(first, 'ls-binance:BTCUSDT'));
  assert.ok(later.some(l => l.key === 'ls-kept'));
  // The view moved away: nothing held of it.
  assert.equal(text(summary.lines(s, held([series('binance:BTCUSDT', pts([500, 0.5]))]), true, KEY, NOW), 'ls-binance:BTCUSDT'), text(first, 'ls-binance:BTCUSDT'));
  // Another market or series: not this selection's result.
  assert.ok(summary.lines(s, held(fine, { key: 'other' }), true, 'other', NOW).every(l => l.key !== 'ls-kept'));
  assert.equal(text(summary.lines(s, held(fine), true, 'other', NOW), 'ls-stale')?.startsWith('The Long/Short pane last drew'), true);
});

test('a selection ending near the newest reading is not settled until its next reading is due, nor while a venue is read', () => {
  const list = [series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62]))];
  // The selection ends at 12; the reading at 5 ends at 10 unless one comes by 20 (three periods): not settled at 13, settled at 30.
  assert.equal(lsStretch(held(list), { t0: T, t1: T + 12 * M }, T + 13 * M).settled, false);
  assert.equal(lsStretch(held(list), { t0: T, t1: T + 12 * M }, T + 30 * M).settled, true);
  assert.equal(lsStretch(held(list, { loading: true }), { t0: T, t1: T + 10 * M }, NOW).settled, false);
  assert.equal(lsStretch(held([{ ...list[0]!, pending: true }]), { t0: T, t1: T + 10 * M }, NOW).settled, false);
  assert.equal(lsStretch(held(list, { asked: { from: T + 5 * M, to: NOW } }), { t0: T, t1: T + 10 * M }, NOW).settled, false, 'the window asked does not reach back to it');
  // A replay: its moment ends the selection, and the series given are those published by then (the next reading not yet out).
  const replay = lsStretch(held([series('binance:BTCUSDT', pts([0, 0.6]))], { replayAt: T + 12 * M }), { t0: T, t1: T + 30 * M }, NOW);
  assert.deepEqual([replay.t1, replay.venues[0]!.covered / M], [T + 12 * M, 5]);
});

test('Sol r6: a kept live result never shows in a replay; a selection no step covers yet is not settled while a reading could still come', () => {
  const list = [series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62], [10, 0.66], [15, 0.68], [20, 0.70]))], summary = new LsRangeSummary(), s = sel(0, 25);
  assert.equal(text(summary.lines(s, held(list), true, KEY, NOW), 'ls-binance:BTCUSDT'), 'Binance | +10.0 pp | 60.0% → 70.0%');
  // A replay rewound to minute 12: the pane gives the readings published by then; the live result must not stand in for them.
  const cut = [series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62]))];
  const replay = summary.lines(s, held(cut, { replayAt: T + 12 * M }), true, KEY, NOW);
  assert.equal(replay.find(l => l.key === 'ls-kept'), undefined);
  assert.match(text(replay, 'ls-binance:BTCUSDT')!, /^Binance \| \+2\.0 pp \| 60\.0% → 62\.0%/);
  // One reading at 0, a selection from 6 to 14 at minute 16: nothing covers it yet, but a reading at 15 (out at 20) would lengthen it in.
  assert.equal(lsStretch(held([series('binance:BTCUSDT', pts([0, 0.6]))]), { t0: T + 6 * M, t1: T + 14 * M }, T + 16 * M).settled, false);
  assert.equal(lsStretch(held([series('binance:BTCUSDT', pts([0, 0.6]))]), { t0: T + 6 * M, t1: T + 14 * M }, T + 30 * M).settled, true);
});

test('Sol r6: the shared moments are where the venues\' covered time overlaps, gaps included; small moves keep their digits', () => {
  // A: 0-5 and 20-25 (a gap between); B: 10-15 and 20-25. Both are drawn only over 20-25.
  const list = [series('binance:BTCUSDT', pts([0, 0.6], [20, 0.62])), series('bybit:BTCUSDT', pts([10, 0.55], [20, 0.56]))];
  const [spread] = lsStretch(held(list), { t0: T, t1: T + 25 * M }, NOW).spreads;
  assert.deepEqual([spread?.t0, spread?.t1], [T + 20 * M, T + 25 * M - 1]);
  const tiny = new LsRangeSummary().lines(sel(0, 10), held([series('binance:BTCUSDT', pts([0, 0.75049], [5, 0.75051]))]), true, KEY, NOW);
  assert.equal(text(tiny, 'ls-binance:BTCUSDT'), 'Binance | +0.002 pp | 75.049% → 75.051%');
  const tinier = new LsRangeSummary().lines(sel(0, 10), held([series('binance:BTCUSDT', pts([0, 0.750001], [5, 0.750005]))]), true, KEY, NOW);
  assert.match(text(tinier, 'ls-binance:BTCUSDT')!, /increase under 0\.001 pp/);
});

test('review: a replay before the selection says it has not begun; a fuller result still settling replaces an emptier kept one', () => {
  const list = [series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62], [10, 0.66], [15, 0.68], [20, 0.70]))], summary = new LsRangeSummary(), s = sel(0, 25);
  summary.lines(s, held(list), true, KEY, NOW);
  // The replay starts before the selection: the page clock is earlier than when the result was kept.
  const early = summary.lines(s, held([], { replayAt: T - 10 * M }), true, KEY, T - 10 * M);
  assert.equal(text(early, 'ls-none'), 'This selection has not begun yet.');
  // An empty settled result kept (the venue held nothing then); its readings come back and their newest step is still settling.
  const later = new LsRangeSummary(), s2 = sel(10, 20), noon = T + 25 * M;
  later.lines(s2, held([series('binance:BTCUSDT', pts([0, 0.6]))]), true, KEY, noon);
  const back = later.lines(s2, held([series('binance:BTCUSDT', pts([0, 0.6], [10, 0.62]))]), true, KEY, noon + M);
  assert.equal(back.find(l => l.key === 'ls-kept'), undefined);
  assert.match(text(back, 'ls-binance:BTCUSDT')!, /62\.0% \| one reading · 5 min of 10 min covered/);
});

test('review: one-reading venues claim no change at the shared moments; no market with a ratio, unread venues and the Bitget note', () => {
  const two = [series('binance:BTCUSDT', pts([0, 0.6])), series('bybit:BTCUSDT', pts([0, 0.55], [2, 0.57], [4, 0.58]), { periodMs: 2 * M })];
  const lines = new LsRangeSummary().lines(sel(0, 5), held(two), true, KEY, NOW);
  assert.equal(text(lines, 'ls-shared-accounts-binance:BTCUSDT'), 'Binance | one reading');
  assert.match(text(lines, 'ls-shared-accounts-bybit:BTCUSDT')!, /^Bybit \| \+/);
  assert.equal(text(new LsRangeSummary().lines(sel(0, 5), null, true, KEY, NOW, '', true), 'ls-none'), 'None of the open-interest markets is on an exchange that publishes a long/short ratio (Binance, Bybit, OKX, Bitget, Gate).');
  // OKX not readable here: its period is not listed among the readings.
  const mixed = [series('binance:BTCUSDT', pts([0, 0.6], [15, 0.61]), { periodMs: 15 * M }), series('okx:BTC-USDT-SWAP', [], { status: 'serverOnly' })];
  assert.equal(text(new LsRangeSummary().lines(sel(0, 30), held(mixed), true, KEY, NOW), 'ls-status'), 'Long share by venue · readings of 15m');
  // Bitget's note only where its readings start after the selection does, not for the newest edge of a live selection.
  const bitget = (from: number) => [series('bitget:BTCUSDT', pts(...Array.from({ length: 6 }, (_, i) => [from + 5 * i, 0.7] as [number, number])))];
  assert.equal(new LsRangeSummary().lines(sel(0, 30), held(bitget(10)), true, KEY, NOW).some(l => l.key === 'ls-bitget'), true);
  assert.equal(new LsRangeSummary().lines(sel(10, 50), held(bitget(5)), true, KEY, T + 37 * M).some(l => l.key === 'ls-bitget'), false);
  // A routine refresh (a round under way, every venue holding readings) neither keeps nor says "being read".
  const refresh = new LsRangeSummary().lines(sel(0, 15), held([series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62], [10, 0.64]))], { loading: true }), true, KEY, NOW);
  assert.ok(!refresh.some(l => l.key === 'ls-kept' || l.key === 'ls-reading'));
});

test('review 2: being read only while a venue can still answer; tile digits; a flat line is no change; a replay keeps its result the next minute', () => {
  const binance = series('binance:BTCUSDT', pts([0, 0.6], [5, 0.62], [10, 0.64]));
  // OKX a page can never read: a routine refresh says nothing. A first round with venues not answered yet says they are being read.
  const okx = series('okx:BTC-USDT-SWAP', [], { status: 'serverOnly' });
  assert.ok(!new LsRangeSummary().lines(sel(0, 15), held([binance, okx], { loading: true }), true, KEY, NOW).some(l => l.key === 'ls-reading'));
  const first = held([binance], { loading: true, ids: ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP'] });
  assert.ok(new LsRangeSummary().lines(sel(0, 15), first, true, KEY, NOW).some(l => l.key === 'ls-reading'));
  // The tile tells a tiny range's ends apart and gives its width, and a flat line's last share sits on its mean.
  const tiny = new LsRangeSummary().lines(sel(0, 10), held([series('binance:BTCUSDT', pts([0, 0.75049], [5, 0.75051]))]), true, KEY, NOW);
  const rows = tiny.find(l => l.kind === 'grid')!.grid![0]!.rows!;
  assert.deepEqual([rows.find(r => r.label === 'Drawn range')?.value, rows.find(r => r.label === 'Range width')?.value], ['75.049% – 75.051%', '0.002 pp']);
  const flat = new LsRangeSummary().lines(sel(0, 20), held([series('binance:BTCUSDT', pts([0, 0.457], [5, 0.457], [10, 0.457], [15, 0.457]))]), true, KEY, NOW);
  assert.equal(flat.find(l => l.kind === 'grid')!.grid![0]!.rows!.find(r => r.label === 'Last held share against the time mean')?.value, '0.00 pp');
  // A replay playing on: the result kept at minute 40 stands at 41 when a venue's update then fails.
  const summary = new LsRangeSummary(), s = sel(0, 25), list = [series('binance:BTCUSDT', pts([0, 0.6], [10, 0.66], [20, 0.70]))];
  summary.lines(s, held(list, { replayAt: T + 40 * M }), true, KEY, T + 40 * M);
  const next = summary.lines(s, held([series('binance:BTCUSDT', [], { status: 'failed' })], { replayAt: T + 41 * M }), true, KEY, T + 41 * M);
  assert.equal(text(next, 'ls-binance:BTCUSDT'), 'Binance | +10.0 pp | 60.0% → 70.0%');
});

test('review 2: every venue on one reading gives the gap alone; Bitget\'s note never for a selection newer than what it holds', () => {
  const ones = [series('binance:BTCUSDT', pts([0, 0.6])), series('bybit:BTCUSDT', pts([0, 0.55]))];
  const lines = new LsRangeSummary().lines(sel(0, 5), held(ones), true, KEY, NOW);
  assert.equal(text(lines, 'ls-spread-accounts'), 'Highest minus lowest long share | 5.0 pp');
  assert.equal(lines.find(l => l.key === 'h-ls-shared-accounts'), undefined);
  const bitget = series('bitget:BTCUSDT', pts([0, 0.7], [5, 0.7], [10, 0.7], [15, 0.7], [20, 0.7], [25, 0.7]));
  assert.equal(new LsRangeSummary().lines(sel(100, 120), held([bitget]), true, KEY, NOW).some(l => l.key === 'ls-bitget'), false);
  assert.equal(new LsRangeSummary().lines(sel(-30, 20), held([bitget]), true, KEY, NOW).some(l => l.key === 'ls-bitget'), true);
});

test('review 3: a tiny gap keeps its digits; the gap alone names its moments when they are not the whole selection', () => {
  const two = [series('binance:BTCUSDT', pts([0, 0.55], [5, 0.5502])), series('bybit:BTCUSDT', pts([0, 0.55], [5, 0.55]))];
  assert.equal(text(new LsRangeSummary().lines(sel(0, 10), held(two), true, KEY, NOW), 'ls-spread-accounts'), 'Highest minus lowest long share at those moments | 0.00 pp → 0.02 pp');
  const late = [series('binance:BTCUSDT', pts(...Array.from({ length: 12 }, (_, i) => [5 * i, 0.6] as [number, number]))), series('bitget:BTCUSDT', pts([55, 0.735]))];
  const lines = new LsRangeSummary().lines(sel(0, 60), held(late), true, KEY, NOW);
  assert.equal(text(lines, 'ls-spread-accounts'), 'Highest minus lowest long share | 13.5 pp');
  assert.match(text(lines, 'ls-shared-note-accounts')!, /^Compared at .* the same venues at both: Binance, Bitget\./);
});

test('the key names the market, timeframe, series and markets', () => {
  assert.equal(lsHeldKey({ marketId: 'binance:BTCUSDT', timeframe: '5m', lsMetric: 'accounts' }, ['binance:BTCUSDT', 'bybit:BTCUSDT']), KEY);
  const pop: LsPopulation = 'topPositions';
  assert.notEqual(lsHeldKey({ marketId: 'binance:BTCUSDT', timeframe: '5m', lsMetric: pop }, ['binance:BTCUSDT']), KEY);
});
