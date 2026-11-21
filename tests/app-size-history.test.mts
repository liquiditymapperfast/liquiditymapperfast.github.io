import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, PLAIN_ALPHA, QUIET_ALPHA, alphaOf, bandLabel, buildHistory, cardLines, emphasis, heightOf, judge, preRollMs, rowCap, unusualRows, type HistoryInput } from '../src/app/size-history/model.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
import { DEFAULT_HIGHLIGHT } from '../src/app/anomaly.ts';

const MIN = 60_000, TF = 15 * MIN, T0 = Date.UTC(2026, 10, 20, 0, 0);
const H = { on: true, mult: 2, length: 72 } as const;

/** A bar of a 15-minute candle with these box buys and sells (eight each), recorded over `minutes` of it. */
function bar(i: number, buy: number[], sell: number[], minutes = 15): Bar {
  const b = buy.reduce((a, x) => a + x, 0), s = sell.reduce((a, x) => a + x, 0);
  return { t: T0 + i * TF, rows: [], buyUsd: b, sellUsd: s, minutes, stats: { buyN: 10, sellN: 10, buy, sell } };
}
const boxes = (v: Partial<Record<number, number>>): number[] => Array.from({ length: 8 }, (_, k) => v[k] ?? 0);
const input = (bars: (Bar | null)[], over: Partial<HistoryInput> = {}): HistoryInput => ({
  times: bars.map((_, i) => T0 + i * TF), bars, tfMs: TF, now: T0 + bars.length * TF + MIN, mode: 'delta', oiJudged: true, highlight: H, ...over,
});

test('the six bands are runs of the eight size boxes, named by their dollars', () => {
  assert.deepEqual(BANDS, [[0, 0], [1, 2], [3, 4], [5, 5], [6, 6], [7, 7]]);
  assert.deepEqual(BANDS.map((_, b) => bandLabel(b)), ['< $25K', '$25K–100K', '$100K–500K', '$500K–1M', '$1M–5M', '≥ $5M']);
});

test('a sparse row is judged against its earlier NON-ZERO candles: zeros never flag and never sit in a baseline', () => {
  // Every fifth candle has an order of about $6M, the rest none; one candle holds $30M.
  const values = Array.from({ length: 400 }, (_, i) => i % 5 === 0 ? 6e6 + (i % 7) * 1e5 : 0);
  values[300] = 30e6;
  const j = judge(values, () => true, H);
  for (let i = 0; i < values.length; i++) if (values[i] === 0) { assert.equal(j.flag[i], 0); assert.ok(Number.isNaN(j.sigma[i]!)); }
  assert.equal(j.flag[300], 1, 'the giant stands out against the other large orders');
  const ordinary = values.map((v, i) => i).filter(i => values[i]! > 0 && i !== 300 && i > 80);
  assert.equal(ordinary.filter(i => j.flag[i]).length, 0, 'an ordinary large order is not unusual only because most candles had none');
  // With the zeros in a slot window (the app's rule as it is), every one of them would have flagged.
  const first = values.findIndex(v => v > 0), twelfth = values.map((v, i) => [v, i] as const).filter(([v]) => v > 0)[12]![1];
  assert.equal(j.short[first], 1, 'too few earlier candles with any: not judged yet');
  assert.ok(Number.isFinite(j.sigma[twelfth]!), 'from the thirteenth non-zero candle on it is judged');
  assert.equal(j.seen[twelfth], 12);
});

test('candles not admitted (recorded in part) are neither judged nor in a baseline', () => {
  const values = Array.from({ length: 60 }, () => 100);
  values[40] = 10_000;
  const j = judge(values, i => i !== 40, H);
  assert.ok(Number.isNaN(j.sigma[40]!)); assert.equal(j.flag[40], 0);
  assert.equal(j.seen[41], 40, 'the candle after it counts the forty admitted before it');
});

test('emphasis: nothing below half the multiple, full at the multiple, a flag on a flat baseline full', () => {
  assert.equal(emphasis(0.9, false, 2), 0);
  assert.equal(emphasis(1, false, 2), 0);
  assert.equal(emphasis(2, false, 2), 1);
  assert.equal(emphasis(5, true, 2), 1);
  assert.ok(Math.abs(emphasis(1.5, false, 2) - 0.5) < 1e-12, 'smooth, half at three quarters of the threshold');
  assert.equal(emphasis(0, true, 2), 1, 'flagged with no spread (sigma 0)');
  assert.equal(emphasis(NaN, false, 2), 0);
  assert.equal(emphasis(3, false, 4), 0.5, 'scaled with the Highlights multiple');
  assert.equal(alphaOf(0, true), QUIET_ALPHA); assert.equal(alphaOf(1, true), 1); assert.equal(alphaOf(0.3, false), PLAIN_ALPHA);
});

test('heights grow with the square root of the amount on the row\'s own scale; a lone giant is cut', () => {
  const values = new Float64Array(40).map((_, i) => (i + 1) * 1e6);
  values[39] = 1e10;
  const row = { parts: [{ values }] } as never;
  const cap = rowCap(row, Array.from({ length: 40 }, (_, i) => i));
  assert.ok(cap > 0 && cap < Math.sqrt(1e10), 'the giant does not set the scale');
  assert.equal(heightOf(1e10, cap).cut, true); assert.equal(heightOf(1e10, cap).share, 1);
  const small = heightOf(4e6, cap), larger = heightOf(16e6, cap);
  assert.ok(Math.abs(larger.share / small.share - 2) < 1e-9, 'four times the amount, twice the height');
  assert.deepEqual(heightOf(5, 0), { share: 0, cut: false });
});

test('the rows: liquidations split, open interest by its sign, six bands as delta or as buys and sells', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, boxes({ 0: 100, 1: 50, 2: 25, 7: i === 29 ? 9e6 : 0 }), boxes({ 0: 40, 3: 70, 4: 10 })));
  const liq = { buy: new Map(bars.map(b => [b.t, 1000] as const)), sell: new Map(bars.map(b => [b.t, 500] as const)), cut: true, cutStarts: new Set([bars[5]!.t]) };
  const oi = new Map(bars.map((b, i) => [b.t, i % 2 ? 2e6 : -1e6] as const));
  const m = buildHistory(input(bars, { liquidations: liq, oi }));
  assert.deepEqual(m.rows.map(r => r.key), ['liq', 'oi', 'size0', 'size1', 'size2', 'size3', 'size4', 'size5']);
  const [liqRow, oiRow, b0, b1, b2] = m.rows;
  assert.equal(liqRow!.parts.length, 2); assert.equal(liqRow!.parts[0]!.side, 1); assert.equal(liqRow!.parts[1]!.side, -1);
  assert.equal(liqRow!.parts[0]!.values[3], 1000); assert.equal(liqRow!.parts[1]!.values[3], 500);
  assert.equal(m.liqCut[5], 1); assert.equal(m.liqCut[4], 0);
  assert.equal(oiRow!.parts[0]!.values[1], 2e6); assert.equal(oiRow!.parts[0]!.values[2], -1e6);
  assert.equal(b0!.parts[0]!.values[0], 60, '< $25K: 100 bought, 40 sold');
  assert.equal(b1!.parts[0]!.values[0], 75, '$25K-100K: boxes 1 and 2');
  assert.equal(b2!.parts[0]!.values[0], -80, '$100K-500K: boxes 3 and 4 sold');
  assert.equal(m.rows[7]!.parts[0]!.values[29], 9e6);
  assert.equal(m.total[0], 100 + 50 + 25 + 40 + 70 + 10);
  const split = buildHistory(input(bars, { mode: 'split' }));
  assert.equal(split.rows[2]!.parts.length, 2); assert.equal(split.rows[2]!.parts[0]!.values[0], 100); assert.equal(split.rows[2]!.parts[1]!.values[0], 40);
  // Without liquidations or open interest the rows are there, every slot not known.
  assert.ok(Number.isNaN(split.rows[0]!.parts[0]!.values[0]!)); assert.ok(Number.isNaN(split.rows[1]!.parts[0]!.values[0]!));
});

test('a candle recorded in part is not judged and stays out of the baselines; a candle without a bar is not known', () => {
  const bars: (Bar | null)[] = Array.from({ length: 40 }, (_, i) => bar(i, boxes({ 0: 100 + i }), boxes({ 0: 10 }), i === 30 ? 9 : 15));
  bars[35] = null;
  const m = buildHistory(input(bars));
  assert.equal(m.partial[30], 1); assert.ok(Math.abs(m.cover[30]! - 0.6) < 1e-12);
  assert.ok(Number.isNaN(m.rows[2]!.parts[0]!.sigma[30]!), 'not judged');
  assert.ok(Number.isNaN(m.rows[2]!.parts[0]!.values[35]!), 'no bar: not known');
  // Liquidations and open interest are not the recording's: they are judged however much of the candle it holds.
  assert.equal(m.partial[29], 0);
});

test('open interest is not judged on a one-minute chart, and Highlights off judges nothing', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, boxes({ 0: 100 }), boxes({ 0: 10 })));
  const oi = new Map(bars.map((b, i) => [b.t, i === 25 ? 1e9 : 1e6 + i] as const));
  assert.ok(buildHistory(input(bars, { oi, oiJudged: true })).rows[1]!.parts[0]!.flag[25] === 1);
  const minute = buildHistory(input(bars, { oi, oiJudged: false }));
  assert.equal(minute.rows[1]!.parts[0]!.flag[25], 0); assert.ok(Number.isNaN(minute.rows[1]!.parts[0]!.sigma[25]!));
  const off = buildHistory(input(bars, { oi, highlight: { ...H, on: false } }));
  assert.ok(off.rows.every(r => r.parts.every(p => p.flag.every(f => f === 0))));
});

test('"k of n size rows unusual" counts a row once, whichever side flags, and only rows judged', () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(i, boxes({ 0: 100, 3: i === 39 ? 1e7 : 100 }), boxes({ 0: 50, 3: 50, 5: i === 39 ? 1e7 : 50 })));
  const m = buildHistory(input(bars, { mode: 'split' }));
  const k = unusualRows(m, 39);
  assert.equal(k.flagged, 2, 'the $100K-500K buys and the $500K-1M sells');
  assert.equal(k.judged, 3, 'the bands with any orders there: under $25K, $100K-500K and $500K-1M');
});

test('the card says the amounts, how unusual, what it is judged against, and the candle under way', () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(i, boxes({ 3: i === 39 ? 5e6 : 1e5 + i * 100 }), boxes({ 3: 4e4 })));
  const liq = { buy: new Map(bars.map(b => [b.t, 2000] as const)), sell: new Map(bars.map(b => [b.t, 0] as const)), cut: true, cutStarts: new Set([bars[39]!.t]) };
  const m = buildHistory(input(bars, { liquidations: liq }));
  const ctx = { time: '20 Nov 09:45', live: true, judging: true, oiSource: null, oiNote: null, mult: 2 } as const;
  const size = cardLines(m, 4, 39, ctx).map(l => `${l.label ?? ''}|${l.text}`);
  assert.equal(size[0], '|Market orders $100K–500K');
  assert.ok(size.includes('Candle|20 Nov 09:45 · in progress: amounts so far'));
  assert.ok(size.some(l => l.startsWith('Buys / sells|$5') && l.includes('$40')));
  assert.ok(size.some(l => /^Unusual\|\d+\.\dσ above its baseline$/.test(l)), size.join('\n'));
  assert.ok(size.includes('|Its baseline: the 39 earlier candles with orders of this size'));
  assert.ok(size.includes('Unusual size rows|1 of 1'), size.join('\n'));
  const liqCard = cardLines(m, 0, 39, { ...ctx, live: false }).map(l => `${l.label ?? ''}|${l.text}`);
  assert.ok(liqCard.some(l => l.startsWith('Shorts liquidated|≥ $')), liqCard.join('\n'));
  assert.ok(liqCard.some(l => l.includes('only its largest 5,000 are counted')));
  assert.equal(liqCard.filter(l => l.startsWith('Shorts liquidated|')).length, 1, 'the judgement is named apart from the amount');
  const spot = cardLines(m, 1, 39, { ...ctx, oiNote: 'spot' }).map(l => l.text);
  assert.ok(spot.includes('Only spot markets are counted: they have no open interest.'));
  const partialBars = bars.map((b, i) => i === 20 ? { ...b, minutes: 5 } : b);
  const p = buildHistory(input(partialBars, { liquidations: liq })), lines = cardLines(p, 4, 20, ctx).map(l => `${l.label ?? ''}|${l.text}`);
  assert.ok(lines.includes('Unusual|Not judged: part of the candle was not recorded'), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('Recorded|33 %')));
  // Liquidations are not the recording's: their card says nothing of what the recording holds.
  assert.equal(cardLines(p, 0, 20, ctx).some(l => l.label === 'Recorded'), false);
});

test('the words follow the brightness: Not unusual, Close to unusual from three quarters of the multiple, Unusual where the rule flags', () => {
  // Forty candles alternating 100 and 120 (mean 110, sd 10), then 128 (1.8 sigma: lit, not flagged), 112 (about 0.2) and 160 (flagged).
  const values = [...Array.from({ length: 40 }, (_, i) => i % 2 ? 120 : 100), 128, 112, 160];
  const bars = values.map((v, i) => bar(i, boxes({ 0: v }), boxes({ 0: 0 })));
  const m = buildHistory(input(bars)), ctx = { time: 't', live: false, judging: true, oiSource: null, oiNote: null, mult: 2 } as const;
  const label = (i: number): string | undefined => cardLines(m, 2, i, ctx).find(l => /σ/.test(l.text))?.label;
  assert.equal(label(40), 'Close to unusual');
  assert.equal(label(41), 'Not unusual');
  assert.equal(label(42), 'Unusual');
});

test('a closed candle is partial under 95 % of its minutes; the one under way only when more than its minute under way is missing', () => {
  const at = T0 + 30 * TF;
  // Ten minutes into the candle: nine recorded (the tenth not counted yet) is whole; seven recorded is partial.
  const one = buildHistory(input([bar(30, boxes({ 0: 1 }), boxes({ 0: 1 }), 9)], { times: [at], now: at + 9.5 * MIN }));
  assert.equal(one.partial[0], 0);
  const three = buildHistory(input([bar(30, boxes({ 0: 1 }), boxes({ 0: 1 }), 7)], { times: [at], now: at + 9.5 * MIN }));
  assert.equal(three.partial[0], 1);
  // Closed: 14 of 15 minutes is under 95 %, as Bar stats fades it.
  const closed = buildHistory(input([bar(30, boxes({ 0: 1 }), boxes({ 0: 1 }), 14)], { times: [at], now: at + 20 * MIN }));
  assert.equal(closed.partial[0], 1);
});

test('the history before the view: the Highlights length of candles, and at least six hours', () => {
  assert.equal(preRollMs(DEFAULT_HIGHLIGHT.length, MIN), 6 * 3_600_000, 'a one-minute chart: six hours, not 72 minutes');
  assert.equal(preRollMs(72, 3_600_000), 72 * 3_600_000);
});
