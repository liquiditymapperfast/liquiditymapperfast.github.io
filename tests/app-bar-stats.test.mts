import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_STATS, DAY_MS, DEFAULT_STAT_OPTIONS, PRESETS, agreement, liquidationBuckets, dayStartOf, deviation, diagonalImbalances, pinnedLines, pinsAfterClick, MAX_PINS, tableBands, tableHeight, enabledStats, rowScale, stackedRuns, stackedZones, statDef, strength, type StatInput, type StatOptions } from '../src/app/panes/bar-stats.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
import { readStatOptions } from '../src/app/stat-options.ts';
import type { Liquidation } from '../src/shared/liquidations.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';

const MIN = 60_000;
const bar = (t: number, rows: [number, number, number][], stats?: Bar['stats']): Bar => ({ t, rows, buyUsd: rows.reduce((s, r) => s + r[1], 0), sellUsd: rows.reduce((s, r) => s + r[2], 0), ...(stats ? { stats } : {}) });
const zeros = () => [0, 0, 0, 0, 0, 0, 0, 0];
const tradeStats = (buyN: number, sellN: number, buy: number[], sell: number[]) => ({ buyN, sellN, buy, sell });
const bars = [
  bar(0, [[100, 30, 10], [105, 5, 20]], tradeStats(2, 1, [100, 0, 0, 0, 0, 0, 0, 5_000_000], [0, 0, 60_000, 0, 0, 0, 0, 0])),
  bar(MIN, [[100, 0, 0]]),
  bar(2 * MIN, [[110, 40, 40], [115, 10, 2]], tradeStats(1, 1, [0, 0, 0, 0, 0, 80_000, 0, 0], [0, 25_000, 0, 0, 0, 0, 0, 0])),
];
const candles = new Map<number, CandleRow>([[0, [0, 100, 112, 99, 105, 55, 1]], [2 * MIN, [2 * MIN, 110, 118, 108, 116, 92, 1]]]);
const oi = new Map<number, OiBar>([[0, [0, 1000, 1010, 990, 1005]], [2 * MIN, [2 * MIN, 1005, 1020, 1000, 1002]]]);
const input = (options: Partial<StatOptions> = {}): StatInput => ({ bars, step: 5, candles, oi, options: { ...DEFAULT_STAT_OPTIONS, ...options } });
const compute = (id: string, options: Partial<StatOptions> = {}) => statDef(id)!.compute(input(options));

test('volume, delta, cumulative delta and the buy/sell split follow the executions of each bar', () => {
  assert.deepEqual(compute('vol'), [65, 0, 92]);
  assert.deepEqual(compute('delta'), [5, 0, 8]);
  assert.deepEqual(compute('cvd'), [5, 5, 13], 'running sum over the bars given');
  assert.deepEqual(compute('buyVol'), [35, 0, 50]);
  assert.deepEqual(compute('sellVol'), [30, 0, 42]);
  const pct = compute('deltaPct');
  assert.ok(Math.abs(pct[0]! - 5 / 65 * 100) < 1e-9);
  assert.equal(pct[1], null, 'no executions, no share');
});

test('row extremes and the point of control come from the price rows', () => {
  assert.deepEqual(compute('maxBuy'), [30, 0, 40]);
  assert.deepEqual(compute('maxSell'), [20, 0, 40]);
  assert.deepEqual(compute('poc'), [102.5, 102.5, 112.5], 'row 100 (40) beats 105 (25); the empty bar falls on its only row; 110 (80) beats 115 (12)');
});

test('diagonal imbalances compare a level with the opposite side one row away and stack when adjacent', () => {
  const rows: [number, number, number][] = [[100, 5, 90], [105, 20, 10], [110, 90, 5], [115, 100, 4]];
  const found = diagonalImbalances(rows, 5, { imbRatio: 3, imbMinUsd: 0 });
  assert.deepEqual(found, [{ low: 100, side: 'sell', ratio: 4.5 }, { low: 110, side: 'buy', ratio: 9 }, { low: 115, side: 'buy', ratio: 20 }], 'sell 90 vs buy 20 above; buy 90 vs sell 10 below; buy 100 vs sell 5 below');
  assert.equal(stackedRuns(found, 5, 2), 1, 'two adjacent buy rows');
  assert.equal(stackedRuns(found, 5, 3), 0);
  assert.deepEqual(stackedZones(found, 5, 2), [{ side: 'buy', low: 110, high: 120 }], 'the run as a price span, from its lowest row\'s bottom to its highest row\'s top');
  assert.deepEqual(diagonalImbalances(rows, 5, { imbRatio: 3, imbMinUsd: 95 }), [{ low: 115, side: 'buy', ratio: 20 }], 'minimum size filters small levels');
  // An empty row inside the candle counts only with imbZeros; past the candle's top or bottom there is nothing to compare with.
  const gap: [number, number, number][] = [[100, 10, 40], [110, 30, 5]];
  assert.deepEqual(diagonalImbalances(gap, 5, { imbRatio: 3, imbMinUsd: 0 }), []);
  assert.deepEqual(diagonalImbalances(gap, 5, { imbRatio: 3, imbMinUsd: 0, imbZeros: true }), [{ low: 100, side: 'sell', ratio: Infinity }, { low: 110, side: 'buy', ratio: Infinity }]);
  assert.deepEqual(diagonalImbalances(rows, 5, { imbRatio: 30, imbMinUsd: 0 }), [], 'a higher ratio finds none');
  assert.deepEqual(diagonalImbalances([[100, 50, 0], [110, 0, 50]], 5, { imbRatio: 3, imbMinUsd: 0 }), [], 'rows two steps apart are not neighbours');
  assert.deepEqual(compute('imbalances', { imbRatio: 1.2 }).map(v => typeof v), ['number', 'number', 'number']);
});

test('trade stats exist only for bars recorded with them and size buckets split retail from whales', () => {
  assert.deepEqual(compute('trades'), [3, null, 2]);
  assert.deepEqual(compute('buys'), [2, null, 1]);
  assert.deepEqual(compute('sells'), [1, null, 1]);
  assert.deepEqual(compute('avgTrade'), [(100 + 5_000_000 + 60_000) / 3, null, 105_000 / 2]);
  assert.deepEqual(compute('deltaRetail'), [100 - 60_000, null, -25_000], 'under $100K by default: the first three boxes');
  assert.deepEqual(compute('deltaWhales'), [5_000_000, null, 80_000], 'from $500K by default: the last three');
  assert.deepEqual(compute('deltaRetail', { retailUsd: 50_000 }), [100, null, -25_000], 'the retail size moves with the option');
  assert.deepEqual(compute('deltaWhales', { whaleUsd: 5_000_000 }), [5_000_000, null, 0]);
  assert.deepEqual(compute('cvdRetail'), [-59_900, null, -84_900], 'running sum skips bars without stats');
  assert.deepEqual(compute('cvdWhales'), [5_000_000, null, 5_080_000]);
  assert.equal(zeros().length, 8);
});

test('a size between the box edges is exact where the bars carry its line, and taken at the nearest edge (with ≈) where they do not', () => {
  // The bars were loaded with lines at $75K and $2M: their sums are the orders themselves.
  const lined = bars.map((b, i) => i === 1 ? b : { ...b, over: i === 0 ? [5_000_000, 0, 5_000_000, 0] : [80_000, 0, 0, 0] });
  const options = { ...DEFAULT_STAT_OPTIONS, retailUsd: 75_000, whaleUsd: 2_000_000 };
  const at = (id: string, cuts?: number[], list = lined) => { const i: StatInput = { bars: list, step: 5, candles, oi, options, ...(cuts ? { cuts } : {}) }; return { values: statDef(id)!.compute(i), approx: statDef(id)!.approx?.(i) ?? false }; };
  assert.deepEqual(at('deltaRetail', [75_000, 2_000_000]), { values: [100 - 60_000, null, -25_000], approx: false }, 'retail: everything less the orders from $75K');
  assert.deepEqual(at('deltaWhales', [75_000, 2_000_000]), { values: [5_000_000, null, 0], approx: false });
  // Without the lines (an older server): the boxes at the nearest edge, $100K and $1M, and the rows say they are about.
  assert.deepEqual(at('deltaRetail', undefined, bars), { values: [100 - 60_000, null, -25_000], approx: true });
  assert.deepEqual(at('deltaWhales', undefined, bars), { values: [5_000_000, null, 0], approx: true });
  assert.equal(at('deltaRetail', [50_000, 2_000_000]).approx, true, 'lines for other sizes are not this one\'s');
  assert.equal(statDef('delta')!.approx, undefined, 'a statistic of the whole bar is never about');
  // At a box edge the boxes are exact, with or without the lines.
  const edge = { ...DEFAULT_STAT_OPTIONS, retailUsd: 100_000, whaleUsd: 1_000_000 };
  assert.equal(statDef('cvdRetail')!.approx!({ bars, step: 5, candles, oi, options: edge }), false);
});

test('candle and open-interest stats read the bar of the same period, in the unit chosen', () => {
  assert.deepEqual(compute('range'), [13, null, 10]);
  assert.deepEqual(compute('oiChange'), [null, null, -3], 'base coin by default; the first bar has no bar before it to be compared with');
  assert.deepEqual(compute('oiChange', { oiUnits: 'usd' }), [null, null, -3 * 116], 'change times the bar close');
});

test('open-interest change is the step from the close of the bar before, so a bar holding one reading still shows that it moved', () => {
  const points = new Map<number, OiBar>([[0, [0, 100, 100, 100, 100]], [MIN, [MIN, 250, 250, 250, 250]]]);   // one reading per bar: open = close
  const found = statDef('oiChange')!.compute({ bars: bars.slice(0, 2), step: 5, candles, oi: points, options: { ...DEFAULT_STAT_OPTIONS } });
  assert.deepEqual(found, [null, 150], 'the pane shows 150 here; close minus open was 0');
});

test('configuration helpers: presets, order, unknown ids', () => {
  assert.deepEqual(PRESETS.default, ['vol', 'delta', 'cvd']);
  assert.deepEqual(PRESETS.none, []);
  assert.equal(PRESETS.all.length, BAR_STATS.length);
  assert.deepEqual(enabledStats(['delta', 'nope', 'vol', 'delta']).map(d => d.id), ['delta', 'vol']);
  assert.equal(new Set(BAR_STATS.map(d => d.id)).size, BAR_STATS.length, 'ids are unique');
  for (const def of BAR_STATS) assert.equal(typeof def.format(12345.6), 'string', def.id);
  for (const id of PRESETS.default) assert.ok(statDef(id), id);
});

test('colour scale: log between the visible 2nd and 99th percentile, so one outlier does not flatten a row', () => {
  const def = statDef('delta')!;
  const values = [...Array.from({ length: 999 }, (_, i) => i + 1), 1e9];
  const scale = rowScale(def, values)!;
  assert.ok(scale.hi < 1_000 && scale.hi > 900, `p99 ignores the outlier (hi ${scale.hi})`);
  assert.equal(strength(def, 1e9, scale), 1, 'the outlier saturates');
  assert.ok(strength(def, 500, scale) > 0.8 && strength(def, 500, scale) < 1, 'ordinary bars still use the range');
  assert.equal(strength(def, 1, scale), 0, 'at or below the 2nd percentile nothing is shaded');
  assert.equal(strength(def, -500, scale), strength(def, 500, scale), 'the sign does not change the strength');
  assert.equal(rowScale(statDef('poc')!, [1, 2]), null, 'plain stats have no scale');
  assert.equal(rowScale(def, [0, null, undefined]), null, 'nothing to scale');
  const share = statDef('deltaPct')!;
  assert.equal(strength(share, 0, rowScale(share, [-100, -50, 50, 100])), 0);
});

test('bar statistics options from storage or a file: each within what the settings allow, else its default', () => {
  assert.deepEqual(readStatOptions(undefined), DEFAULT_STAT_OPTIONS);
  const good = { imbRatio: 2.5, imbMinUsd: 10_000, stackedN: 4, imbZeros: true, retailUsd: 75_000, whaleUsd: 2_000_000, oiUnits: 'usd', cells: 'unusual', grouped: true, folded: ['trades', 'market'], cvdFrom: 'day' };
  assert.deepEqual(readStatOptions(good), good);
  const bad = readStatOptions({ imbRatio: 0.5, imbMinUsd: -1, stackedN: 2.5, imbZeros: 'yes', retailUsd: 9, whaleUsd: -1, oiUnits: 'eur', cells: 'neon', grouped: 'yes', folded: ['nope', 3], cvdFrom: 'week', extra: 1 });
  assert.deepEqual(bad, DEFAULT_STAT_OPTIONS);
  const crossed = readStatOptions({ retailUsd: 1_000_000, whaleUsd: 100_000 });
  assert.deepEqual([crossed.retailUsd, crossed.whaleUsd], [100_000, 500_000], 'whales may not start under retail');
  assert.deepEqual([readStatOptions({ retailUsd: 25_000, whaleUsd: 25_000 }).retailUsd, readStatOptions({ retailUsd: 25_000, whaleUsd: 25_000 }).whaleUsd], [25_000, 25_000], 'the floor, and the two sizes the same');
  // A save from before the sizes were free holds box numbers: retail up to box 1 is under $50K, whales from box 6 start at $1M.
  const old = readStatOptions({ retailMax: 1, whaleMin: 6 });
  assert.deepEqual([old.retailUsd, old.whaleUsd], [50_000, 1_000_000]);
  assert.deepEqual([readStatOptions({ retailMax: 7, whaleMin: 0 }).retailUsd, readStatOptions({ retailMax: 7, whaleMin: 0 }).whaleUsd], [100_000, 500_000], 'box numbers with no such edge are the defaults');
  assert.equal(readStatOptions({ stackedN: 1 }).stackedN, 3);
});

test('a candle without executions is a slot: the rows read from candles still show there, those read from executions do not', () => {
  const withGap = new Map(candles); withGap.set(MIN, [MIN, 105, 106, 104, 105.5, 10, 1]);
  const slots: StatInput = { bars: [bars[0]!, null, bars[2]!], times: [0, MIN, 2 * MIN], step: 5, candles: withGap, oi, options: { ...DEFAULT_STAT_OPTIONS } };
  assert.deepEqual(statDef('vol')!.compute(slots), [65, null, 92]);
  assert.deepEqual(statDef('cvd')!.compute(slots), [5, null, 13], 'the running sum carries over a slot without a bar');
  assert.deepEqual(statDef('range')!.compute(slots), [13, 2, 10], 'the candle without executions still has its range');
});

test('the candle rows: where it closed in its range, and the effort per basis point of it', () => {
  const close = compute('closePos'), effort = compute('effort');
  assert.ok(Math.abs(close[0]! - 6 / 13 * 100) < 1e-9);
  assert.equal(close[1], null, 'no candle there');
  assert.equal(close[2], 80);
  assert.ok(Math.abs(effort[0]! - 55 * (112 + 99 + 105) / 3 / 1300) < 1e-9, 'its dollars at the typical price over 1300 bp');
  assert.ok(Math.abs(effort[2]! - 92 * 114 / (10 / 110 * 10_000)) < 1e-9);
});

test('the footprint rows: the point of control in the candle and how far it moved', () => {
  const pos = compute('pocPos');
  assert.ok(Math.abs(pos[0]! - 3.5 / 13 * 100) < 1e-9, 'row 100 (its middle 102.5) in 99 to 112');
  assert.ok(Math.abs(pos[2]! - 45) < 1e-9);
  assert.deepEqual(compute('pocMove'), [null, 0, 10], 'none for the first; 102.5 to 102.5, then to 112.5');
});

test('delta against the candle marks buying into a fall and selling into a rise, from 5 % of the volume', () => {
  assert.deepEqual(compute('divergence'), [0, null, 0], 'both bars bought into a rising candle');
  const falling = new Map(candles); falling.set(0, [0, 112, 112, 99, 100, 55, 1]);
  assert.deepEqual(statDef('divergence')!.compute({ ...input(), candles: falling }), [1, null, 0], 'net buying while the candle fell: ▲');
  assert.equal(statDef('divergence')!.format(1), '▲');
  assert.equal(statDef('divergence')!.format(0), '', 'nothing to mark');
  const thin = bar(0, [[100, 51, 49]]);
  assert.deepEqual(statDef('divergence')!.compute({ ...input(), bars: [thin], candles: falling }), [0], 'a delta of 2 % is not marked');
});

test('open interest against delta: the quadrant of the two signs', () => {
  assert.deepEqual(compute('oiQuad'), [null, null, 3], 'the last bar bought while open interest fell: −▲');
  assert.deepEqual(statDef('oiQuad')!.compute({ ...input(), perps: true }), [null, null, 3]);
  assert.deepEqual(statDef('oiQuad')!.compute({ ...input(), perps: false }), [null, null, null], 'spot executions alone (the Spot filter): blank, never read against the perpetuals\' open interest');
  assert.equal(statDef('oiQuad')!.format(3), '−▲');
  assert.equal(statDef('oiQuad')!.tone!(3), 'buy');
  assert.equal(statDef('oiQuad')!.tone!(2), 'sell');
});

test('whale share and the size skew of market buys against sells', () => {
  const share = compute('whaleShare');
  assert.ok(Math.abs(share[0]! - 5_000_000 / 5_060_100 * 100) < 1e-9);
  assert.equal(share[1], null);
  assert.ok(Math.abs(share[2]! - 80_000 / 105_000 * 100) < 1e-9);
  const skew = compute('sizeSkew');
  assert.ok(Math.abs(skew[0]! - Math.log2((5_000_100 / 2) / 60_000)) < 1e-9);
  assert.ok(Math.abs(skew[2]! - Math.log2(80_000 / 25_000)) < 1e-9);
  assert.equal(statDef('sizeSkew')!.format(Math.log2(3.2)), '×3.2');
});

test('coverage is the minutes recorded over the candle, or over what of it has passed while it runs', () => {
  const hour = 3_600_000, closed = { ...bar(0, [[100, 1, 1]]), minutes: 30 }, live = { ...bar(hour, [[100, 1, 1]]), minutes: 10 };
  const values = statDef('cover')!.compute({ ...input(), bars: [closed, live], tfMs: hour, now: hour + 20 * MIN });
  assert.deepEqual(values, [50, 50]);
  assert.equal(statDef('cover')!.format(100), '', 'a whole candle is not marked');
  assert.equal(statDef('cover')!.format(50), '50%');
  assert.deepEqual(statDef('cover')!.compute({ ...input(), bars: [bar(0, [[100, 1, 1]])], tfMs: hour, now: hour }), [null], 'a source that does not say');
});

test('the candle delta reads the exchange\'s taker buys, and is empty without them', () => {
  // The exchange's own candle, 33 of its 55 coins bought by takers: its buys, volume and price are one snapshot, whatever the chart's candle says.
  const values = statDef('takerDelta')!.compute({ ...input(), taker: new Map<number, CandleRow>([[0, [0, 100, 112, 99, 105, 55, 1, 33]]]) });
  assert.ok(Math.abs(values[0]! - 0.2 * 55 * (112 + 99 + 105) / 3) < 1e-9, 'bought 60 %: delta is a fifth of its dollars');
  assert.deepEqual(values.slice(1), [null, null]);
  assert.deepEqual(statDef('takerDelta')!.compute(input()), [null, null, null], 'a market that does not report them');
});

test('the View column: each statistic over the candles in view, taken as it should be', () => {
  const slots: StatInput = { bars: [bars[0]!, null, bars[2]!], times: [0, MIN, 2 * MIN], step: 5, candles, oi, options: { ...DEFAULT_STAT_OPTIONS } };
  const view = (id: string) => { const def = statDef(id)!; return def.view!(slots, [0, 1, 2], def.compute(slots)); };
  assert.equal(view('vol')!.value, statDef('vol')!.format(157), 'a sum');
  assert.equal(view('cvd')!.value, statDef('cvd')!.format(13), 'a running sum shows its newest');
  assert.equal(view('deltaPct')!.value, statDef('deltaPct')!.format(13 / 157 * 100), 'the shares of the sums, not a sum of shares');
  assert.equal(view('range')!.value, statDef('range')!.format(118 - 99), 'the highest high less the lowest low');
  assert.equal(view('poc')!.value, statDef('poc')!.format(112.5), 'the busiest row of the rows added together');
  assert.equal(view('divergence'), null, 'nothing marked, nothing to say');
  for (const def of BAR_STATS) assert.ok(def.view, `${def.id} has a View figure`);
});

test('the View position of the point of control pairs the candles and the rows of the same candles', () => {
  const onlyCandle = new Map<number, CandleRow>([[0, [0, 100, 200, 100, 150, 10, 1]]]);
  const apart: StatInput = { bars: [null, bar(MIN, [[300, 5, 5]])], times: [0, MIN], step: 5, candles: onlyCandle, oi, options: { ...DEFAULT_STAT_OPTIONS } };
  const def = statDef('pocPos')!;
  assert.deepEqual(def.compute(apart), [null, null], 'neither slot has both');
  assert.equal(def.view!(apart, [0, 1], def.compute(apart)), null, 'a row from one candle is not set in the range of another');
});

test('Highlights read a share around 50 % by its distance from 50, both ways alike', () => {
  const def = statDef('closePos')!;
  assert.equal(deviation(def, 0), deviation(def, 100));
  assert.equal(deviation(statDef('delta')!, -7), 7);
});

test('liquidations by candle: their sum and shorts less longs, none outside the window loaded, ≈ when the answer was cut', () => {
  const liquidations = { buy: new Map([[0, 300], [MIN, 0]]), sell: new Map([[0, 100], [MIN, 0]]), cut: false };
  assert.deepEqual(statDef('liq')!.compute({ ...input(), liquidations }), [400, 0, null], 'the third candle is outside the window loaded');
  assert.deepEqual(statDef('liqNet')!.compute({ ...input(), liquidations }), [200, 0, null], 'shorts liquidated (forced buys) less longs liquidated');
  assert.deepEqual(statDef('liq')!.compute(input()), [null, null, null], 'a source without liquidations');
  assert.equal(statDef('liq')!.approx!({ ...input(), liquidations: { ...liquidations, cut: true } }), true);
  assert.equal(statDef('liq')!.source, 'market', 'shown before the recording too');
});

test('venue agreement: the share of the volume on markets pressing the way the total did', () => {
  const parted = { ...bar(0, [[100, 70, 30], [105, 20, 40]]), parts: [[['a', 60, 10], ['b', 10, 20]], [['a', 10, 10], ['b', 10, 30]]] as Bar['parts'] };
  // a: bought 70, sold 20 (+50); b: bought 20, sold 50 (−30); the total is +20, so a's 90 of the 160 agree.
  assert.deepEqual(statDef('venueAgree')!.compute({ ...input(), bars: [parted] }), [90 / 160 * 100]);
  assert.equal(agreement(new Map([['a', [5, 1] as const]])), null, 'one market agrees with itself: nothing to say');
  assert.deepEqual(statDef('venueAgree')!.compute(input()), [null, null, null], 'bars without the markets\' parts');
});

test('the running sums start again at each day\'s start when asked', () => {
  const days: StatInput = { ...input(), restart: [0, 0, 1] };
  assert.deepEqual(statDef('cvd')!.compute(days), [5, 5, 8], 'the third candle opens a new day');
  assert.deepEqual(statDef('cvd')!.compute(input()), [5, 5, 13]);
  assert.equal(dayStartOf(Date.UTC(2026, 9, 20, 15, 30), 'UTC'), Date.UTC(2026, 9, 20));
});

test('rows grouped by kind under headers, a folded kind\'s rows left out, and the pane sized for them', () => {
  const defs = enabledStats(['delta', 'liq', 'vol', 'poc']);
  assert.deepEqual(tableBands(defs, { grouped: false, folded: [] }).map(b => b.kind === 'row' ? b.def.id : b.group), ['delta', 'liq', 'vol', 'poc'], 'as chosen');
  assert.deepEqual(tableBands(defs, { grouped: true, folded: [] }).map(b => b.kind === 'row' ? b.def.id : `[${b.group}]`), ['[volume]', 'delta', 'vol', '[footprint]', 'poc', '[market]', 'liq'], 'by kind, the order chosen within each');
  assert.deepEqual(tableBands(defs, { grouped: true, folded: ['volume'] }).map(b => b.kind === 'row' ? b.def.id : `[${b.group}]`), ['[volume]', '[footprint]', 'poc', '[market]', 'liq']);
  assert.equal(tableHeight(['delta', 'liq', 'vol', 'poc'], { grouped: false, folded: [] }), 12 + 4 * 24);
  assert.equal(tableHeight(['delta', 'liq', 'vol', 'poc'], { grouped: true, folded: ['volume'] }), 12 + 2 * 24 + 3 * 14);
});

test('a pinned candle\'s card lists every statistic for it', () => {
  const lines = pinnedLines('Oct 20 14:00', [{ label: 'vol', value: '1.2B', tone: 'text' }, { label: 'delta', value: '-3.1M', tone: 'sell' }]);
  assert.deepEqual(lines.map(l => l.label ? `${l.label}: ${l.text}` : l.text).slice(0, 4), ['Pinned', 'Candle: Oct 20 14:00', 'vol: 1.2B', 'delta: -3.1M']);
  assert.equal(lines[3]!.color, 'sell');
});

test('the View figure of venue agreement needs every candle in view to say its markets', () => {
  const parted = { ...bar(0, [[100, 70, 30]]), parts: [[['a', 60, 10], ['b', 10, 20]]] as Bar['parts'] }, bare = bar(MIN, [[100, 0, 1_000]]);
  const def = statDef('venueAgree')!, slots: StatInput = { ...input(), bars: [parted, bare] };
  assert.equal(def.view!(slots, [0, 1], def.compute(slots)), null, 'a heavy candle without them would turn the total');
  const alone: StatInput = { ...input(), bars: [parted] };
  assert.ok(def.view!(alone, [0], def.compute(alone)), 'with them, a figure');
});

test('liquidations by day: a candle counts where its day is answered and the record reaches it, ≈ only from a day that was cut', () => {
  const D = DAY_MS, H = 3_600_000, liq = (t: number, side: 'short' | 'long', usd: number, id = 'a') => ({ t, id, side, price: 1, usd, reported: 1, kind: 'single' }) as unknown as Liquidation;
  const days = new Map([[0, { rows: [liq(H + 5, 'short', 300), liq(H + 9, 'long', 100), liq(2 * H, 'short', 50, 'other')], cut: false, to: D }], [D, { rows: [liq(D + 1, 'long', 70)], cut: true, to: 2 * D }]]);
  const times = [0, H, D, D + H, 2 * D];
  const later = 10 * D, all = liquidationBuckets(days, ['a'], times, H, 0, later);
  assert.deepEqual(times.map(t => all.buy.get(t) ?? null), [0, 300, 0, 0, null], 'shorts liquidated are forced buys; another market is not counted; the third day is not answered');
  assert.deepEqual(times.map(t => all.sell.get(t) ?? null), [0, 100, 70, 0, null]);
  assert.equal(all.cut, true, 'the second day held more than an answer carries');
  const firstDay = liquidationBuckets(days, ['a'], [0, H], H, 0, later);
  assert.equal(firstDay.cut, false, 'candles of the whole first day only: no ≈');
  const recorded = liquidationBuckets(days, ['a'], times, H, H, later);
  assert.equal(recorded.buy.get(0), undefined, 'before the record reaches, not known');
  assert.equal(recorded.buy.get(H), 300);
  // The day under way, asked at 01:30: the candle under way at 01:40 counts as far as the answer reaches; one that closed after it, or started
  // after it, waits for the next answer.
  const running = new Map([[0, { rows: [liq(H + 5, 'short', 300)], cut: false, to: H + H / 2 }]]);
  assert.deepEqual([0, H, 2 * H].map(t => liquidationBuckets(running, ['a'], [0, H, 2 * H], H, 0, H + 40 * 60_000).buy.get(t) ?? null), [0, 300, null]);
  assert.equal(liquidationBuckets(running, ['a'], [H], H, 0, 2 * H + 60_000).buy.get(H), undefined, 'closed after the answer: not known yet');
});

test('a click pins a candle alone, a Shift+click adds it to the pinned ones or takes it away, and the oldest pin gives way past five', () => {
  assert.deepEqual(pinsAfterClick([], 5, false), [5]);
  assert.deepEqual(pinsAfterClick([5], 5, false), [], 'the pinned one is let go');
  assert.deepEqual(pinsAfterClick([5], 6, false), [6], 'another candle: it alone');
  assert.deepEqual(pinsAfterClick([5, 6], 7, false), [7], 'a plain click on a third replaces the pair');
  assert.deepEqual(pinsAfterClick([5, 6], 5, false), [6], 'a plain click on a pinned one lets that one go');
  assert.deepEqual(pinsAfterClick([5], 6, true), [5, 6]);
  assert.deepEqual(pinsAfterClick([5, 6], 6, true), [5], 'Shift on a pinned one takes it away');
  assert.deepEqual(pinsAfterClick([1, 2, 3, 4, 5], 6, true), [2, 3, 4, 5, 6], 'the oldest gives way');
  assert.equal(MAX_PINS, 5);
  const before = [1, 2];
  pinsAfterClick(before, 3, true);
  assert.deepEqual(before, [1, 2], 'the pins given are not changed');
});
