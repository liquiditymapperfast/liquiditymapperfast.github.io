import test from 'node:test';
import assert from 'node:assert/strict';
import { BarsRangeSummary, barsStretch, type BarsPaneHeld } from '../src/app/range/bars-lines.ts';
import { DEFAULT_STAT_OPTIONS, enabledStats, lineOf, statDef, type StatInput, type StatOptions } from '../src/app/panes/bar-stats.ts';
import { volText, type Bar } from '../src/app/panes/footprint.ts';
import { price as fmtPrice } from '../src/app/format.ts';
import type { CandleRow } from '../src/app/store.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';

const M5 = 300_000, T = Date.UTC(2026, 10, 12, 0), NOW = T + 1000 * M5;
const zeros = (): number[] => [0, 0, 0, 0, 0, 0, 0, 0];
/** A bar from its price rows [low, buy, sell], with its recorded minutes (5: all of a closed 5m candle) and trade statistics where given. */
const bar = (t: number, rows: [number, number, number][], extra: Partial<Bar> = {}): Bar => ({ t, rows, buyUsd: rows.reduce((s, r) => s + r[1], 0), sellUsd: rows.reduce((s, r) => s + r[2], 0), minutes: 5, ...extra });
/** Order statistics: buy and sell counts and dollars, all in the smallest size box. */
const orders = (buyN: number, buyUsd: number, sellN: number, sellUsd: number): NonNullable<Bar['stats']> => { const buy = zeros(), sell = zeros(); buy[0] = buyUsd; sell[0] = sellUsd; return { buyN, sellN, buy, sell }; };
const at = (i: number): number => T + i * M5;
const sel = (t0: number, t1: number): RangeSelection => ({ t0, t1, p0: null, p1: null, live: false, draft: false, pane: 'bars', step: M5 });

interface HeldOptions { times?: number[]; candles?: Map<number, CandleRow>; input?: Partial<StatInput>; options?: Partial<StatOptions>; answered?: { from: number; to: number } | null; now?: number; key?: string }
/** A held table of 5m slots from T (or at `times`), the statistics `ids` worked out on it as the pane does. */
function held(bars: (Bar | null)[], ids: string[], o: HeldOptions = {}): BarsPaneHeld {
  const times = o.times ?? bars.map((_, i) => at(i)), now = o.now ?? NOW;
  const input: StatInput = { bars, times, tfMs: M5, now, step: 1, candles: o.candles ?? new Map(), oi: new Map(), options: { ...DEFAULT_STAT_OPTIONS, ...o.options }, ...o.input };
  const defs = enabledStats(ids);
  return { key: o.key ?? 'K', tfMs: M5, tf: '5m', input, times, defs, values: defs.map(d => d.compute(input)), markets: 2, oiMarkets: 1, coin: 'BTC', candleMarket: 'Binance BTCUSDT', quote: 'USDT',
    replayAt: null, answered: o.answered === undefined ? { from: times[0]!, to: times[times.length - 1]! + M5 } : o.answered };
}
const fig = (h: BarsPaneHeld, t0: number, t1: number, id: string) => barsStretch(h, { t0, t1 })!.figures.find(f => f.id === id)!;

test('1: delta % is pooled over the stretch, not the average of the candles\' shares', () => {
  const h = held([bar(at(0), [[100, 950, 50]]), bar(at(1), [[100, 0, 100]])], ['deltaPct', 'delta', 'vol']);
  assert.equal(fig(h, at(0), at(2), 'deltaPct').value, '+72.7%', '800 / 1100');
  assert.equal(fig(h, at(0), at(2), 'delta').value, `+$${volText(800)}`);
  assert.equal(fig(h, at(0), at(2), 'vol').value, `$${volText(1100)}`);
});

test('2: order averages weight by orders and use the size boxes\' dollars, not the footprint\'s', () => {
  const h = held([bar(at(0), [[100, 5000, 0]], { stats: orders(1, 100, 0, 0) }), bar(at(1), [[100, 7000, 0]], { stats: orders(3, 900, 0, 0) })], ['avgTrade', 'avgBuy']);
  assert.equal(fig(h, at(0), at(2), 'avgTrade').value, `$${volText(250)}`, '1000 / 4, not (100 + 300) / 2');
  assert.equal(fig(h, at(0), at(2), 'avgBuy').value, `$${volText(250)}`);
});

test('3: the point of control is pooled by price; the largest row stays a single candle\'s', () => {
  const h = held([bar(at(0), [[100, 60, 0], [110, 59, 0]]), bar(at(1), [[100, 0, 0], [110, 59, 0]])], ['poc', 'maxBuy']);
  const poc = fig(h, at(0), at(2), 'poc');
  assert.equal(poc.value, fmtPrice(110.5));
  assert.equal(poc.label, 'Pooled point of control');
  const max = fig(h, at(0), at(2), 'maxBuy');
  assert.equal(max.value, `$${volText(60)}`, 'not 118');
  assert.equal(max.label, 'Largest single-candle buy row');
});

test('4: a CVD over the stretch is the change, its increments added up, whatever runs before it or restarts inside it', () => {
  const cut = 300_000, whale = (b: number, s: number): Partial<Bar> => ({ stats: orders(1, b + 10, 1, s + 10), over: [b, s] });
  const rows = [bar(at(0), [[100, 100, 0]], whale(100, 0)), bar(at(1), [[100, 10, 0]], whale(10, 0)), bar(at(2), [[100, 0, 4]], whale(0, 4))];
  for (const restart of [undefined, [0, 0, 1]]) {
    const h = held(rows, ['cvd', 'cvdWhales', 'cvdRetail'], { options: { whaleUsd: cut, retailUsd: cut }, input: { cuts: [cut], ...(restart ? { restart } : {}) } });
    const cvd = fig(h, at(1), at(3), 'cvd');
    assert.equal(cvd.value, `+$${volText(6)}`, 'not the level 106 nor the first-close subtraction −4');
    assert.equal(cvd.label, 'CVD change');
    assert.equal(fig(h, at(1), at(3), 'cvdWhales').value, `+$${volText(6)}`);
    // Retail: the orders under the line, (b + 10 − b) − (s + 10 − s) = 0 a candle.
    assert.equal(fig(h, at(1), at(3), 'cvdRetail').value, '$0');
  }
});

test('5: candles of the grid without executions count in the denominators, one missing from the table too', () => {
  const two = held([bar(at(0), [[100, 1, 1]]), null], ['cover', 'vol']);
  const s = barsStretch(two, { t0: at(0), t1: at(2) })!;
  assert.deepEqual([s.withBars, s.expected, s.recorded, s.minutes, s.unknown], [1, 2, 5, 10, 0]);
  assert.equal(s.figures.find(f => f.id === 'cover')!.value, '50%');
  assert.equal(s.figures.find(f => f.id === 'vol')!.known, 1);
  // The middle start is in neither the candles nor the bars: still a candle of the selection, inside the table's span (not out of view).
  const gap = held([bar(at(0), [[100, 1, 1]]), bar(at(2), [[100, 1, 1]])], ['cover'], { times: [at(0), at(2)] });
  const g = barsStretch(gap, { t0: at(0), t1: at(3) })!;
  assert.deepEqual([g.expected, g.spanned, g.withBars, g.recorded, g.minutes, g.unknown], [3, 3, 2, 10, 15, 0]);
  assert.equal(g.figures[0]!.value, '67%');
  const lines = new BarsRangeSummary().lines(sel(at(0), at(3)), gap, true, 'K', NOW);
  assert.equal(lines.find(l => l.key === 'bs-candles')?.cells.join(' | '), 'Candles with executions held | 2 of 3');
  assert.equal(lines.find(l => l.key === 'bs-minutes')?.cells.join(' | '), 'Recorded minutes, any market | 10 of 15 · 67%');
  assert.equal(lines.find(l => l.key === 'bs-partial'), undefined);
});

test('6: minutes a bar does not count, or the footprint was not asked about, are unknown; the forming candle counts what has passed', () => {
  const legacy = held([bar(at(0), [[100, 1, 1]]), bar(at(1), [[100, 1, 1]], { minutes: undefined })], ['cover']);
  const s = barsStretch(legacy, { t0: at(0), t1: at(2) })!;
  assert.deepEqual([s.recorded, s.unknown, s.minutes], [5, 5, 10]);
  assert.equal(s.figures[0]!.value, null, 'no percentage with minutes unknown');
  const lines = new BarsRangeSummary().lines(sel(at(0), at(2)), legacy, true, 'K', NOW);
  assert.equal(lines.find(l => l.key === 'bs-minutes')?.cells.join(' | '), 'Recorded minutes held | 5 of 10');
  assert.equal(lines.find(l => l.key === 'bs-unknown')?.cells.join(' | '), 'Coverage unknown | 5 minutes');
  // Before the answered span: a slot without a bar there is unknown, not zero.
  const early = held([null, bar(at(1), [[100, 1, 1]])], ['cover'], { answered: { from: at(1), to: at(2) } });
  assert.deepEqual((({ recorded, unknown }) => [recorded, unknown])(barsStretch(early, { t0: at(0), t1: at(2) })!), [5, 5]);
  // A candle 2.5 minutes old: three minutes so far.
  const forming = held([bar(at(0), [[100, 1, 1]]), bar(at(1), [[100, 1, 1]], { minutes: 3 })], ['cover'], { now: at(1) + 150_000 });
  const f = barsStretch(forming, { t0: at(0), t1: at(2) })!;
  assert.deepEqual([f.recorded, f.minutes], [8, 8]);
  assert.match(new BarsRangeSummary().lines(sel(at(0), at(2)), forming, true, 'K', at(1) + 150_000)[0]!.cells[0]!, /forming$/);
});

test('7: ≈ is decided on the selected candles alone, for size lines and for cut days of liquidations', () => {
  const cut = 300_000, options = { whaleUsd: cut };
  const exact = bar(at(0), [[100, 1, 1]], { stats: orders(1, 400_000, 0, 0), over: [400_000, 0] }), boxes = bar(at(1), [[100, 1, 1]], { stats: orders(1, 400_000, 0, 0) });
  const liquidations = { buy: new Map([[at(0), 10], [at(1), 20]]), sell: new Map([[at(0), 0], [at(1), 0]]), cut: true, cutStarts: new Set([at(1)]) };
  const h = held([exact, boxes], ['deltaWhales', 'liq'], { options, input: { cuts: [cut], liquidations } });
  assert.equal(lineOf(boxes, h.input, 'whale')?.exact, false, 'the outside bar is taken at a box edge');
  assert.equal(statDef('deltaWhales')!.approx!(h.input), true, 'the whole table says ≈');
  assert.equal(fig(h, at(0), at(1), 'deltaWhales').approx, false);
  assert.equal(fig(h, at(0), at(1), 'liq').approx, false);
  assert.equal(fig(h, at(0), at(2), 'deltaWhales').approx, true);
  assert.equal(fig(h, at(0), at(2), 'liq').approx, true);
  const lines = new BarsRangeSummary().lines(sel(at(0), at(2)), h, true, 'K', NOW);
  assert.ok(lines.some(l => l.key === 'bs-approx-size' && l.cells[0]!.includes('delta whales')));
  assert.ok(lines.some(l => l.key === 'bs-approx-liq'));
});

test('8: markets\' agreement is pooled over the stretch; a traded candle without its markets refuses it', () => {
  const a = bar(at(0), [[100, 10, 8]], { parts: [[['a', 10, 0], ['b', 0, 8]]] }), b = bar(at(1), [[100, 10, 8]], { parts: [[['a', 0, 8], ['b', 10, 0]]] });
  const h = held([a, b, bar(at(2), [[100, 5, 1]])], ['venueAgree']);
  assert.deepEqual(h.values[0]!.slice(0, 2).map(v => Math.round(v!)), [56, 56], 'each candle alone');
  assert.equal(fig(h, at(0), at(2), 'venueAgree').value, '100%', 'pooled: both markets +2');
  assert.equal(fig(h, at(0), at(3), 'venueAgree').value, null);
});

test('9: marks are counted by kind, zero and unavailable apart; spot markets alone leave OI × delta unavailable', () => {
  const candles = new Map<number, CandleRow>([[at(0), [at(0), 100, 101, 98, 99, 1, 1]], [at(1), [at(1), 100, 102, 99, 101, 1, 1]], [at(2), [at(2), 100, 102, 99, 101, 1, 1]]]);
  const rows = [bar(at(0), [[100, 90, 10]]), bar(at(1), [[100, 10, 90]]), bar(at(2), [[100, 50, 50]]), bar(at(3), [[100, 90, 10]])];
  const d = fig(held(rows, ['divergence'], { candles }), at(0), at(4), 'divergence');
  assert.deepEqual(d.rows!.map(r => `${r.label} ${r.value}`), ['Net buying / price down 1', 'Net selling / price up 1', 'No opposite-direction mark 1', 'Unavailable 1']);
  const oiChange = new Map([[at(0), 5], [at(1), 5], [at(2), -5], [at(3), -5], [at(4), 0]]);
  const quad = [bar(at(0), [[100, 9, 1]]), bar(at(1), [[100, 1, 9]]), bar(at(2), [[100, 9, 1]]), bar(at(3), [[100, 1, 9]]), bar(at(4), [[100, 9, 1]]), bar(at(5), [[100, 9, 1]])];
  const q = fig(held(quad, ['oiQuad'], { input: { oiChange } }), at(0), at(6), 'oiQuad');
  assert.deepEqual(q.rows!.map(r => r.value), ['1', '1', '1', '1', '1', '1']);
  const spot = fig(held(quad, ['oiQuad'], { input: { oiChange, perps: false } }), at(0), at(6), 'oiQuad');
  assert.deepEqual(spot.rows!.map(r => r.value), ['0', '0', '0', '0', '0', '6']);
  assert.equal(spot.value, null);
});

test('10: the point of control\'s place in the range needs rows and a candle of the same slot', () => {
  const candles = new Map<number, CandleRow>([[at(1), [at(1), 100, 110, 90, 105, 1, 1]]]);
  const h = held([bar(at(0), [[100, 5, 5]]), null], ['pocPos'], { candles });
  assert.equal(fig(h, at(0), at(2), 'pocPos').value, null);
  assert.equal(fig(h, at(0), at(2), 'pocPos').known, 0);
});

test('11: nothing to divide by is unavailable; buy-only and sell-only candles still pool into the averages and the skew', () => {
  const flat = new Map<number, CandleRow>([[at(0), [at(0), 100, 100, 100, 100, 1, 1]]]);
  const none = held([bar(at(0), [[100, 0, 0]], { stats: orders(0, 0, 0, 0) })], ['avgTrade', 'deltaPct', 'closePos', 'venueAgree'], { candles: flat });
  for (const id of ['avgTrade', 'deltaPct', 'closePos']) assert.equal(fig(none, at(0), at(1), id).value, null, id);
  const zero = held([bar(at(0), [[100, 10, 10]], { parts: [[['a', 5, 5], ['b', 5, 5]]] })], ['venueAgree']);
  assert.equal(fig(zero, at(0), at(1), 'venueAgree').value, null, 'no delta to agree with');
  const sides = held([bar(at(0), [[100, 1000, 0]], { stats: orders(4, 1000, 0, 0) }), bar(at(1), [[100, 0, 300]], { stats: orders(0, 0, 2, 300) })], ['sizeSkew', 'avgTrade']);
  assert.deepEqual(sides.values[0], [null, null], 'neither candle has a skew of its own');
  const skew = fig(sides, at(0), at(2), 'sizeSkew');
  assert.equal(skew.value, 'Buy orders averaged ×1.7 sell orders', '250 against 150');
  assert.equal(skew.known, 2);
  assert.equal(fig(sides, at(0), at(2), 'avgTrade').value, `$${volText(1300 / 6)}`);
});

test('12: a closed selection\'s complete result is kept while the view moves away, and given up for another market or choice', () => {
  const rows = [bar(at(0), [[100, 30, 10]]), bar(at(1), [[100, 5, 25]]), bar(at(2), [[100, 7, 3]])];
  const all = held(rows, ['vol', 'delta', 'poc']), summary = new BarsRangeSummary(), s = sel(at(0), at(2));
  const first = summary.lines(s, all, true, 'K', NOW);
  assert.equal(summary.lines(s, all, true, 'K', NOW), first, 'a redraw with the same snapshot reuses the lines');
  const value = (lines: typeof first, key: string) => lines.find(l => l.key === key)?.cells.join(' | ');
  assert.equal(value(first, 'bs-delta'), 'Delta | $0', '+20 and −20');
  // Partly in view, then not at all, then no table: the kept result, its row step and scope with it.
  for (const later of [held(rows.slice(1), ['vol', 'delta', 'poc'], { times: [at(1), at(2)] }), held([rows[2]!], ['vol', 'delta', 'poc'], { times: [at(2)] }), null]) {
    const lines = summary.lines(s, later, true, 'K', NOW);
    assert.equal(value(lines, 'bs-vol'), value(first, 'bs-vol'));
    assert.ok(lines.some(l => l.key === 'bs-kept'));
    assert.match(value(lines, 'bs-status')!, /rows of \$1/);
  }
  // Another market or choice of stats: not this selection's result.
  assert.ok(summary.lines(s, held(rows.slice(1), ['vol'], { times: [at(1), at(2)], key: 'K2' }), true, 'K2', NOW).every(l => l.key !== 'bs-kept'));
  assert.ok(summary.lines(s, null, true, 'K3', NOW).some(l => l.key === 'bs-none'));
  // New data for the same candles is worked out again.
  const more = held([bar(at(0), [[100, 300, 10]]), rows[1]!, rows[2]!], ['vol', 'delta', 'poc']);
  assert.notEqual(value(summary.lines(s, more, true, 'K', NOW), 'bs-vol'), value(first, 'bs-vol'));
});

test('the leading figures are lines in the person\'s order, the rest a grid; the per-candle move says so', () => {
  const h = held([bar(at(0), [[100, 3, 1]], { stats: orders(1, 3, 1, 1) }), bar(at(1), [[101, 2, 4]], { stats: orders(1, 2, 2, 4) })], ['trades', 'pocMove', 'vol', 'buys']);
  const lines = new BarsRangeSummary().lines(sel(at(0), at(2)), h, true, 'K', NOW);
  assert.deepEqual(lines.filter(l => l.kind === 'stat' && l.key.startsWith('bs-') && !['bs-candles', 'bs-minutes'].includes(l.key)).map(l => l.cells[0]), ['Market orders', 'Volume']);
  const grid = lines.find(l => l.kind === 'grid')!.grid!;
  assert.deepEqual(grid.map(g => [g.label, g.value]), [['poc move', 'per candle only'], ['buys', '2']]);
  assert.equal(lines.find(l => l.key === 'h-bs-grid')?.cells[0], 'More chosen stats');
});

test('review: candles outside the table are unknown even where the footprint was answered wider than the view', () => {
  // The selection is six candles, the table holds three of them, the footprint was answered for all six.
  const h = held([bar(at(3), [[100, 1, 1]]), bar(at(4), [[100, 1, 1]], { minutes: 3 }), bar(at(5), [[100, 1, 1]])], ['cover', 'vol'], { times: [at(3), at(4), at(5)], answered: { from: at(0), to: at(6) } });
  const s = barsStretch(h, { t0: at(0), t1: at(6) })!;
  assert.deepEqual([s.expected, s.spanned, s.withBars, s.recorded, s.unknown, s.minutes], [6, 3, 3, 13, 15, 30]);
  assert.equal(s.figures.find(f => f.id === 'cover')!.value, null, 'no exact percentage over minutes nobody looked at');
});

test('review: figures near a thousand keep their units, zero takes no side, a gap inside the table is a candle without data', () => {
  const h = held([bar(at(0), [[100, 999.6, 0]])], ['vol', 'delta']);
  assert.equal(fig(h, at(0), at(1), 'vol').value, `$${volText(999.6)}`);
  assert.equal(fig(h, at(0), at(1), 'delta').value, `+$${volText(999.6)}`);
  const even = held([bar(at(0), [[100, 50, 50]])], ['delta', 'deltaPct']);
  assert.deepEqual([fig(even, at(0), at(1), 'delta').tone, fig(even, at(0), at(1), 'deltaPct').tone], ['text', 'text']);
  const gap = held([bar(at(0), [[100, 1, 1]]), bar(at(2), [[100, 1, 1]])], ['vol'], { times: [at(0), at(2)] });
  const g = barsStretch(gap, { t0: at(1), t1: at(2) })!;
  assert.deepEqual([g.expected, g.spanned, g.withBars, g.figures[0]!.value], [1, 1, 0, null]);
  const lines = new BarsRangeSummary().lines(sel(at(1), at(2)), gap, true, 'K', NOW);
  assert.equal(lines.find(l => l.key === 'bs-vol')?.cells.join(' | '), 'Volume | unavailable');
  assert.equal(lines.find(l => l.key === 'bs-partial'), undefined, 'not outside the view');
});

test('review: no statistic chosen, the candle market for marks read on candles, the liquidation note, a point of control without volume', () => {
  assert.equal(new BarsRangeSummary().lines(sel(at(0), at(1)), null, true, 'K', NOW, '', true).find(l => l.key === 'bs-none')?.cells[0], 'No statistics selected: use Stats to add some.');
  const candles = new Map<number, CandleRow>([[at(0), [at(0), 100, 101, 98, 99, 1, 1]]]);
  const marks = new BarsRangeSummary().lines(sel(at(0), at(1)), held([bar(at(0), [[100, 90, 10]])], ['divergence'], { candles }), true, 'K', NOW);
  assert.match(marks.find(l => l.key === 'bs-status')!.cells[0]!, /candles of Binance BTCUSDT/);
  const liquidations = { buy: new Map([[at(0), 10]]), sell: new Map([[at(0), 0]]), cut: true, cutStarts: new Set([at(0)]) };
  const liq = new BarsRangeSummary().lines(sel(at(0), at(1)), held([bar(at(0), [[100, 1, 1]])], ['liq'], { input: { liquidations } }), true, 'K', NOW);
  assert.equal(liq.find(l => l.key === 'bs-approx-liq')?.cells[0], '≈ liq: a day of these candles held more than 5,000 liquidations, and only its largest 5,000 are counted.');
  assert.equal(fig(held([bar(at(0), [[100, 0, 0], [101, 0, 0]])], ['poc']), at(0), at(1), 'poc').value, null);
});

test('review 2: a share of the range at 0 % keeps its colour; the point of control\'s place needs volume on the candles it is read on', () => {
  const low = new Map<number, CandleRow>([[at(0), [at(0), 100, 110, 90, 90, 1, 1]]]);
  const close = fig(held([bar(at(0), [[100, 1, 1]])], ['closePos'], { candles: low }), at(0), at(1), 'closePos');
  assert.deepEqual([close.value, close.tone], ['0%', 'sell']);
  // Volume only where there is no candle, a candle only where nothing traded: no place in the range.
  const apart = new Map<number, CandleRow>([[at(1), [at(1), 100, 110, 90, 105, 1, 1]]]);
  const h = held([bar(at(0), [[100, 5, 5]]), bar(at(1), [[100, 0, 0]])], ['pocPos'], { candles: apart });
  assert.equal(fig(h, at(0), at(2), 'pocPos').value, null);
});

test('review: a kept result is not replaced by one the pane holds fewer executions for', () => {
  const rows = [bar(at(0), [[100, 30, 10]]), bar(at(1), [[100, 5, 25]])], summary = new BarsRangeSummary(), s = sel(at(0), at(2));
  const first = summary.lines(s, held(rows, ['vol']), true, 'K', NOW);
  const thin = summary.lines(s, held([null, rows[1]!], ['vol']), true, 'K', NOW);
  assert.equal(thin.find(l => l.key === 'bs-vol')?.cells[1], first.find(l => l.key === 'bs-vol')?.cells[1]);
  assert.equal(thin.find(l => l.key === 'bs-kept')?.cells[0], 'As worked out earlier, when the pane held more of these candles\' executions.');
  // Once it holds them all again, the result is worked out from what it holds.
  assert.equal(summary.lines(s, held(rows, ['vol']), true, 'K', NOW).find(l => l.key === 'bs-kept'), undefined);
});
